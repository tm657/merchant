import { webhookEventSchema, type Payout, type WebhookDeliveriesPage, type WebhookEndpoint } from "@mini-payments/shared";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { after, describe, it } from "node:test";
import { verifyWebhookSignature } from "../../scripts/webhook-receiver.js";
import { publishOutboxBatch } from "../outbox.js";
import { makeTestApp, TEST_WEBHOOK_KEY, TEST_WEBHOOK_POLICY } from "../test/helpers.js";
import { decryptSecret, encryptSecret, generateWebhookSecret, signatureHeader } from "./crypto.js";
import { createDeliveryWorker } from "./delivery.js";
import { sendWebhook, type SendResult } from "./http.js";
import { checkWebhookUrl, isBlockedAddress, resolveTarget } from "./ssrf.js";

type T = Awaited<ReturnType<typeof makeTestApp>>;
const log = { info() {}, warn() {}, error() {} } as never;
const STRICT = { requireHttps: false, allowPrivate: false };

/** A local HTTP server answering with `handler`; records what it received. */
async function receiver(handler: (req: http.IncomingMessage, res: http.ServerResponse, body: string) => void = (_q, s) => s.end("ok")) {
  const received: { headers: http.IncomingHttpHeaders; body: string }[] = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c: Buffer) => (body += c.toString("utf8")));
    req.on("end", () => {
      received.push({ headers: req.headers, body });
      handler(req, res, body);
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  after(() => server.close());
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/hook`, received, server };
}

describe("webhook secrets", () => {
  it("round-trips through AES-GCM and refuses tampering or another endpoint's row", () => {
    const secret = generateWebhookSecret();
    assert.match(secret, /^whsec_[A-Za-z0-9_-]{43}$/);
    const stored = encryptSecret(TEST_WEBHOOK_KEY, secret, "we_a");
    assert.ok(!stored.includes(secret));
    assert.notEqual(encryptSecret(TEST_WEBHOOK_KEY, secret, "we_a"), stored, "random IV each time");
    assert.equal(decryptSecret(TEST_WEBHOOK_KEY, stored, "we_a"), secret);
    assert.throws(() => decryptSecret(TEST_WEBHOOK_KEY, stored, "we_b"), "AAD binds it to the endpoint");
    const [v, iv, tag, ct] = stored.split(":");
    const flipped = Buffer.from(ct!, "base64url");
    flipped[0]! ^= 1;
    assert.throws(() => decryptSecret(TEST_WEBHOOK_KEY, [v, iv, tag, flipped.toString("base64url")].join(":"), "we_a"));
    assert.throws(() => decryptSecret(Buffer.alloc(32, 7), stored, "we_a"), "wrong key");
  });

  it("signs t.body with HMAC-SHA256, verifiable by the demo receiver, with both secrets during rotation", () => {
    const [current, previous] = [generateWebhookSecret(), generateWebhookSecret()];
    const body = JSON.stringify({ hello: "world" });
    const t = 1_800_000_000;
    const header = signatureHeader([current, previous], body, t);
    assert.match(header, /^t=1800000000,v1=[0-9a-f]{64},v1=[0-9a-f]{64}$/);
    const now = { nowMs: t * 1000 };
    assert.equal(verifyWebhookSignature(header, body, [current], now).ok, true);
    assert.equal(verifyWebhookSignature(header, body, [previous], now).ok, true, "old secret still verifies");
    assert.deepEqual(verifyWebhookSignature(header, `${body} `, [current], now), { ok: false, reason: "signature mismatch" });
    assert.deepEqual(verifyWebhookSignature(header, body, [current], { nowMs: (t + 301) * 1000 }), {
      ok: false,
      reason: "timestamp outside tolerance",
    });
    assert.equal(verifyWebhookSignature(undefined, body, [current]).ok, false);
  });
});

describe("SSRF protection", () => {
  it("blocks private, loopback, link-local, reserved and IPv4-in-IPv6 addresses", () => {
    const blocked = [
      "127.0.0.1", "10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.1.1", "169.254.169.254", "100.64.0.1",
      "0.0.0.0", "224.0.0.1", "255.255.255.255", "198.18.0.1", "::1", "::", "fe80::1", "fc00::1", "fd12:3456::1",
      "ff02::1", "::ffff:127.0.0.1", "::ffff:7f00:1", "::ffff:169.254.169.254", "64:ff9b::a00:1", "2002:7f00:1::",
      "2001:db8::1", "fe80::1%eth0", "not-an-ip",
    ];
    const allowed = ["8.8.8.8", "1.1.1.1", "172.32.0.1", "93.184.216.34", "2606:4700:4700::1111", "::ffff:8.8.8.8", "64:ff9b::808:808"];
    for (const ip of blocked) assert.equal(isBlockedAddress(ip), true, `${ip} should be blocked`);
    for (const ip of allowed) assert.equal(isBlockedAddress(ip), false, `${ip} should be allowed`);
  });

  it("checks URLs: https in production, no credentials, no private IP literals", () => {
    assert.throws(() => checkWebhookUrl("http://example.com/x", { requireHttps: true, allowPrivate: false }), /only https/);
    assert.ok(checkWebhookUrl("https://example.com/x", { requireHttps: true, allowPrivate: false }));
    assert.throws(() => checkWebhookUrl("https://user:pw@example.com/", STRICT), /credentials/);
    assert.throws(() => checkWebhookUrl("ftp://example.com/", STRICT), /http/);
    assert.throws(() => checkWebhookUrl("http://169.254.169.254/latest/meta-data", STRICT), /link-local/);
    assert.throws(() => checkWebhookUrl("http://[::1]:8080/", STRICT), /loopback/);
  });

  it("never allows link-local or reserved targets, even with private targets allowed", () => {
    const relaxed = { requireHttps: false, allowPrivate: true };
    assert.throws(() => checkWebhookUrl("http://169.254.169.254/latest/meta-data", relaxed), /link-local/);
    assert.throws(() => checkWebhookUrl("http://[fe80::1]/", relaxed), /link-local/);
    assert.throws(() => checkWebhookUrl("http://[::ffff:169.254.169.254]/", relaxed), /link-local/);
    assert.throws(() => checkWebhookUrl("http://0.0.0.0/", relaxed), /reserved/);
    assert.ok(checkWebhookUrl("http://127.0.0.1:4500/", relaxed));
    assert.ok(checkWebhookUrl("http://192.168.1.10/", relaxed));
  });

  it("refuses hostnames that resolve to blocked addresses", async () => {
    await assert.rejects(resolveTarget("localhost", STRICT), /loopback|private/);
    assert.ok((await resolveTarget("localhost", { requireHttps: false, allowPrivate: true })).length > 0);
  });

  it("sends only to vetted addresses, follows no redirects, times out, and caps the response", async () => {
    const ok = await receiver();
    const blocked = await sendWebhook({ url: ok.url.replace("127.0.0.1", "localhost"), body: "{}", headers: {}, policy: STRICT });
    assert.equal(blocked.ok, false);
    assert.match(blocked.error!, /loopback|private/);
    assert.equal(ok.received.length, 0, "nothing reached the server");

    const allowed = await sendWebhook({ url: ok.url, body: "{}", headers: {}, policy: TEST_WEBHOOK_POLICY });
    assert.deepEqual(allowed, { ok: true, status: 200, error: null });

    const redirect = await receiver((_req, res) => res.writeHead(302, { location: "http://169.254.169.254/" }).end());
    const r = await sendWebhook({ url: redirect.url, body: "{}", headers: {}, policy: TEST_WEBHOOK_POLICY });
    assert.deepEqual(r, { ok: false, status: 302, error: "redirects are not followed (got 302)" });

    const slow = await receiver(() => {}); // never answers
    const started = Date.now();
    const timedOut = await sendWebhook({ url: slow.url, body: "{}", headers: {}, policy: TEST_WEBHOOK_POLICY, timeoutMs: 300 });
    assert.equal(timedOut.ok, false);
    assert.match(timedOut.error!, /timed out after 300 ms/);
    assert.ok(Date.now() - started < 2000);

    const huge = await receiver((_req, res) => {
      res.writeHead(200);
      const chunk = "x".repeat(16 * 1024);
      const timer = setInterval(() => res.write(chunk), 1); // endless body
      res.on("close", () => clearInterval(timer));
    });
    const capped = await sendWebhook({ url: huge.url, body: "{}", headers: {}, policy: TEST_WEBHOOK_POLICY, maxResponseBytes: 64 * 1024 });
    assert.deepEqual(capped, { ok: true, status: 200, error: null }, "stops reading, keeps the status");

    const failing = await receiver((_req, res) => res.writeHead(503).end());
    assert.deepEqual(await sendWebhook({ url: failing.url, body: "{}", headers: {}, policy: TEST_WEBHOOK_POLICY }), {
      ok: false,
      status: 503,
      error: "HTTP 503",
    });
  });
});

async function adminOf(t: T) {
  return t.tokenFor("admin@test.com");
}

async function createEndpoint(t: T, url: string, events = ["payout.created", "payout.approved"]) {
  const res = await t.app.inject({
    method: "POST",
    url: "/orgs/org_1/webhooks",
    headers: { authorization: `Bearer ${await adminOf(t)}` },
    payload: { url, events, description: "test" },
  });
  assert.equal(res.statusCode, 201, res.body);
  return res.json() as { endpoint: WebhookEndpoint; secret: string };
}

async function createPayout(t: T): Promise<Payout> {
  const res = await t.app.inject({
    method: "POST",
    url: "/orgs/org_1/payouts",
    headers: { authorization: `Bearer ${await t.tokenFor("multi@test.com")}`, "idempotency-key": `wh-${Math.random().toString(36).slice(2)}` },
    payload: { amount: 250, currency: "USD", beneficiaryName: "Acme", accountNumber: "GB1234567890" },
  });
  return (res.json() as { payout: Payout }).payout;
}

describe("webhook endpoints API", () => {
  it("is admin-only", async () => {
    const t = await makeTestApp();
    assert.equal((await t.get("/orgs/org_1/webhooks", await t.tokenFor("multi@test.com"))).statusCode, 403);
  });

  it("shows the secret only on create and rotate, and stores it encrypted", async () => {
    const t = await makeTestApp();
    const { endpoint, secret } = await createEndpoint(t, "http://127.0.0.1:9/hook");
    const admin = await adminOf(t);
    const list = await t.get("/orgs/org_1/webhooks", admin);
    const one = await t.get(`/orgs/org_1/webhooks/${endpoint.id}`, admin);
    for (const res of [list, one]) assert.ok(!res.body.includes(secret) && !res.body.includes("whsec_"));
    const { rows } = await t.db.query<{ secret_enc: string }>("SELECT secret_enc FROM webhook_endpoints");
    assert.ok(!rows[0]!.secret_enc.includes(secret));

    const rotated = await t.app.inject({ method: "POST", url: `/orgs/org_1/webhooks/${endpoint.id}/rotate`, headers: { authorization: `Bearer ${admin}` } });
    const body = rotated.json() as { endpoint: WebhookEndpoint; secret: string };
    assert.notEqual(body.secret, secret);
    assert.ok(body.endpoint.previousSecretExpiresAt);
    const actions = (await t.db.query<{ action: string }>("SELECT action FROM audit_log WHERE target_id = $1 ORDER BY id", [endpoint.id])).rows;
    assert.deepEqual(actions.map((a) => a.action), ["webhook.endpoint.created", "webhook.endpoint.secret_rotated"]);
    const audited = JSON.stringify((await t.db.query("SELECT metadata FROM audit_log")).rows);
    assert.ok(!audited.includes(secret) && !audited.includes(body.secret), "secrets never reach the audit log");
  });

  it("refuses blocked URLs when SSRF protection is on", async () => {
    const t = await makeTestApp(undefined, { webhookPolicy: STRICT });
    const admin = await adminOf(t);
    for (const url of ["http://127.0.0.1:4500/hook", "http://localhost/x", "http://169.254.169.254/", "http://10.0.0.1/"]) {
      const res = await t.app.inject({
        method: "POST",
        url: "/orgs/org_1/webhooks",
        headers: { authorization: `Bearer ${admin}` },
        payload: { url, events: ["payout.paid"] },
      });
      assert.equal(res.statusCode, 400, url);
      assert.equal((res.json() as { error: string }).error, "webhook_url_not_allowed");
    }
  });

  it("updates, disables and deletes, auditing each change", async () => {
    const t = await makeTestApp();
    const admin = await adminOf(t);
    const { endpoint } = await createEndpoint(t, "http://127.0.0.1:9/hook");
    const patched = await t.app.inject({
      method: "PATCH",
      url: `/orgs/org_1/webhooks/${endpoint.id}`,
      headers: { authorization: `Bearer ${admin}` },
      payload: { enabled: false, events: ["payout.paid"] },
    });
    assert.deepEqual((patched.json() as { endpoint: WebhookEndpoint }).endpoint.events, ["payout.paid"]);
    const del = await t.app.inject({ method: "DELETE", url: `/orgs/org_1/webhooks/${endpoint.id}`, headers: { authorization: `Bearer ${admin}` } });
    assert.equal(del.statusCode, 204);
    assert.equal((await t.get(`/orgs/org_1/webhooks/${endpoint.id}`, admin)).statusCode, 404);
    const actions = (await t.db.query<{ action: string }>("SELECT action FROM audit_log WHERE target_id = $1 ORDER BY id", [endpoint.id])).rows;
    assert.deepEqual(actions.map((a) => a.action), ["webhook.endpoint.created", "webhook.endpoint.updated", "webhook.endpoint.deleted"]);
  });
});

describe("webhook fan-out and delivery", () => {
  it("fans each event out once to subscribed, enabled endpoints only", async () => {
    const t = await makeTestApp();
    const sub = await createEndpoint(t, "http://127.0.0.1:9/a", ["payout.created"]);
    await createEndpoint(t, "http://127.0.0.1:9/b", ["payout.paid"]); // not subscribed
    const off = await createEndpoint(t, "http://127.0.0.1:9/c", ["payout.created"]);
    await t.db.query("UPDATE webhook_endpoints SET enabled = false WHERE id = $1", [off.endpoint.id]);
    await createPayout(t);
    await publishOutboxBatch(t.db, t.redis, { prefix: t.redisPrefix, now: () => new Date(t.clock.now()).toISOString() });
    // Processing the same outbox row again (at-least-once) must not duplicate.
    await t.owner.query("UPDATE outbox SET published_at = NULL");
    await publishOutboxBatch(t.db, t.redis, { prefix: t.redisPrefix, now: () => new Date(t.clock.now()).toISOString() });
    const { rows } = await t.db.query<{ endpoint_id: string; event_type: string }>("SELECT endpoint_id, event_type FROM webhook_deliveries");
    assert.deepEqual(rows, [{ endpoint_id: sub.endpoint.id, event_type: "payout.created" }]);
  });

  it("delivers a signed body the receiver accepts, with integer minor units", async () => {
    const t = await makeTestApp(undefined);
    const hook = await receiver();
    const { secret } = await createEndpoint(t, hook.url);
    const p = await createPayout(t);
    await publishOutboxBatch(t.db, t.redis, { prefix: t.redisPrefix, now: () => new Date(t.clock.now()).toISOString() });
    const worker = createDeliveryWorker({ db: t.db, key: TEST_WEBHOOK_KEY, policy: TEST_WEBHOOK_POLICY, log });
    assert.equal(await worker.runOnce(10), 1);

    const [got] = hook.received;
    assert.ok(got);
    assert.equal(verifyWebhookSignature(got.headers["webhook-signature"] as string, got.body, [secret]).ok, true);
    assert.equal(got.headers["webhook-event"], "payout.created");
    const event = webhookEventSchema.parse(JSON.parse(got.body));
    assert.equal(got.headers["webhook-id"], event.id);
    assert.ok("payout" in event.data);
    assert.equal(event.data.payout.id, p.id);
    assert.equal(event.data.payout.amount, 250);
    assert.ok(!got.body.includes("GB1234567890"), "account number stays masked");
    const { rows } = await t.db.query<{ status: string; last_response_code: number }>("SELECT status, last_response_code FROM webhook_deliveries");
    assert.deepEqual(rows, [{ status: "succeeded", last_response_code: 200 }]);
  });

  it("retries with exponential backoff and marks the delivery dead after 8 attempts", async () => {
    const t = await makeTestApp();
    await createEndpoint(t, "http://127.0.0.1:9/never");
    await createPayout(t);
    await publishOutboxBatch(t.db, t.redis, { prefix: t.redisPrefix, now: () => new Date(t.clock.now()).toISOString() });
    const results: SendResult[] = [];
    const worker = createDeliveryWorker({
      db: t.db,
      key: TEST_WEBHOOK_KEY,
      policy: TEST_WEBHOOK_POLICY,
      log,
      clock: t.clock.now,
      random: () => 0.5,
      backoffBaseMs: 5000,
      send: async () => {
        const r = { ok: false, status: 500, error: "HTTP 500" };
        results.push(r);
        return r;
      },
    });
    const delays: number[] = [];
    for (let i = 1; i <= 8; i++) {
      assert.equal(await worker.runOnce(10), 1, `attempt ${i}`);
      const { rows } = await t.db.query<{ status: string; next_attempt_at: string | null; attempts: number }>(
        "SELECT status, next_attempt_at, attempts FROM webhook_deliveries",
      );
      if (i < 8) {
        assert.equal(rows[0]!.status, "pending");
        assert.equal(await worker.runOnce(10), 0, "not due before its backoff");
        const delay = Date.parse(rows[0]!.next_attempt_at!) - t.clock.now();
        delays.push(delay);
        t.clock.advance(delay);
      } else {
        assert.deepEqual([rows[0]!.status, rows[0]!.attempts, rows[0]!.next_attempt_at], ["dead", 8, null]);
      }
    }
    assert.deepEqual(delays, [5000, 10_000, 20_000, 40_000, 80_000, 160_000, 320_000]);
    assert.equal(results.length, 8);
  });

  it("never lets two delivery workers claim the same row (SKIP LOCKED)", async () => {
    const t = await makeTestApp();
    await createEndpoint(t, "http://127.0.0.1:9/x", ["payout.created"]);
    for (let i = 0; i < 8; i++) await createPayout(t);
    await publishOutboxBatch(t.db, t.redis, { prefix: t.redisPrefix, now: () => new Date(t.clock.now()).toISOString() });
    const make = () => createDeliveryWorker({ db: t.db, key: TEST_WEBHOOK_KEY, policy: TEST_WEBHOOK_POLICY, log, clock: t.clock.now });
    const [a, b] = await Promise.all([make().claim(5), make().claim(5)]);
    const ids = [...a, ...b].map((c) => c.id);
    assert.equal(ids.length, 8);
    assert.equal(new Set(ids).size, 8);
  });

  it("redelivers the same bytes as a new delivery, and audits it", async () => {
    const t = await makeTestApp();
    const hook = await receiver();
    const { endpoint } = await createEndpoint(t, hook.url);
    await createPayout(t);
    await publishOutboxBatch(t.db, t.redis, { prefix: t.redisPrefix, now: () => new Date(t.clock.now()).toISOString() });
    const worker = createDeliveryWorker({ db: t.db, key: TEST_WEBHOOK_KEY, policy: TEST_WEBHOOK_POLICY, log });
    await worker.runOnce(10);
    const admin = await adminOf(t);
    const page = (await t.get(`/orgs/org_1/webhooks/${endpoint.id}/deliveries`, admin)).json() as WebhookDeliveriesPage;
    const original = page.items[0]!;
    const res = await t.app.inject({
      method: "POST",
      url: `/orgs/org_1/webhooks/${endpoint.id}/deliveries/${original.id}/redeliver`,
      headers: { authorization: `Bearer ${admin}` },
    });
    assert.equal(res.statusCode, 201);
    await worker.runOnce(10);
    assert.equal(hook.received.length, 2);
    assert.equal(hook.received[0]!.body, hook.received[1]!.body);
    assert.equal(hook.received[0]!.headers["webhook-id"], hook.received[1]!.headers["webhook-id"], "same event id, so receivers can dedupe");
    const audited = await t.db.query("SELECT 1 FROM audit_log WHERE action = 'webhook.delivery.redelivered'");
    assert.equal(audited.rowCount, 1);
  });

  it("enqueues transaction.created in the simulator's own transaction", async () => {
    const t = await makeTestApp();
    const { startSimulator } = await import("../simulator.js");
    const sim = startSimulator(t.db, t.bus, log);
    await new Promise((r) => setTimeout(r, 5200)); // one tick every 3–5 s
    await sim.stop();
    const { rows: txns } = await t.db.query<{ id: string }>("SELECT id FROM transactions");
    const { rows } = await t.db.query<{ payload: unknown }>("SELECT payload FROM outbox WHERE type = 'webhook'");
    assert.ok(txns.length >= 1);
    assert.equal(rows.length, txns.length, "one event per transaction, committed together");
    const event = webhookEventSchema.parse(rows[0]!.payload);
    assert.equal(event.type, "transaction.created");
    assert.ok("transaction" in event.data && Number.isInteger(event.data.transaction.amount));
  });
});
