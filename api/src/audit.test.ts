import type { AuditEntry, Payout } from "@mini-payments/shared";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createPayoutWorker } from "./payouts/worker.js";
import { makeTestApp, PASSWORD } from "./test/helpers.js";

type T = Awaited<ReturnType<typeof makeTestApp>>;

async function entries(t: T, where = "TRUE", args: unknown[] = []) {
  const { rows } = await t.db.query<{ action: string; actor_id: string | null; actor_label: string; target_id: string | null; metadata: Record<string, unknown>; ip: string | null; request_id: string | null; org_id: string | null }>(
    `SELECT action, actor_id, actor_label, target_id, metadata, host(ip) AS ip, request_id, org_id FROM audit_log WHERE ${where} ORDER BY id`,
    args,
  );
  return rows;
}

async function createAndApprove(t: T) {
  const finance = await t.tokenFor("multi@test.com");
  const admin = await t.tokenFor("admin@test.com");
  const created = await t.app.inject({
    method: "POST",
    url: "/orgs/org_1/payouts",
    headers: { authorization: `Bearer ${finance}`, "idempotency-key": `audit-${Math.random().toString(36).slice(2)}` },
    payload: { amount: 600, currency: "USD", beneficiaryName: "Acme", accountNumber: "GB1234567890" },
  });
  const p = (created.json() as { payout: Payout }).payout;
  await t.app.inject({
    method: "POST",
    url: `/orgs/org_1/payouts/${p.id}/approve`,
    headers: { authorization: `Bearer ${admin}`, "user-agent": "audit-test", "x-request-id": "req-approve-1" },
    payload: { version: 1 },
    remoteAddress: "10.1.2.3",
  });
  return { p, admin, finance };
}

describe("audit log: what gets recorded", () => {
  it("records login success and both kinds of failure, without the password", async () => {
    const t = await makeTestApp();
    await t.login("admin@test.com", PASSWORD, "10.0.0.7");
    await t.login("admin@test.com", "wrong password");
    await t.login("ghost@test.com", "wrong password");
    const rows = await entries(t, "action LIKE 'auth.%'");
    assert.deepEqual(
      rows.map((r) => [r.action, r.actor_id, r.target_id, r.metadata.reason ?? null, r.metadata.email ?? null]),
      [
        ["auth.login.succeeded", "u_admin", "u_admin", null, null],
        ["auth.login.failed", null, "u_admin", "invalid_credentials", null],
        ["auth.login.failed", null, null, "invalid_credentials", "ghost@test.com"],
      ],
    );
    assert.equal(rows[0]!.actor_label, "admin@test.com");
    assert.equal(rows[0]!.ip, "10.0.0.7");
    assert.ok(!JSON.stringify(rows).includes("wrong password"));
  });

  it("records a rate-limited login as a failure", async () => {
    const t = await makeTestApp();
    for (let i = 0; i < 6; i++) await t.login("admin@test.com", "wrong password");
    const reasons = (await entries(t, "action = 'auth.login.failed'")).map((r) => r.metadata.reason);
    assert.deepEqual(reasons.slice(-1), ["rate_limited"]);
  });

  it("records logout in the same transaction as the session delete", async () => {
    const t = await makeTestApp();
    const token = await t.tokenFor("admin@test.com");
    await t.app.inject({ method: "POST", url: "/auth/logout", headers: { authorization: `Bearer ${token}` } });
    await t.app.inject({ method: "POST", url: "/auth/logout", headers: { authorization: `Bearer ${token}` } });
    assert.equal((await entries(t, "action = 'auth.logout'")).length, 1, "a second logout of a dead session records nothing");
  });

  it("records each pay-out action with actor, IP, user agent and request id", async () => {
    const t = await makeTestApp();
    const { p } = await createAndApprove(t);
    const rows = await entries(t, "target_id = $1", [p.id]);
    assert.deepEqual(rows.map((r) => [r.action, r.actor_id]), [
      ["payout.created", "u_multi"],
      ["payout.approved", "u_admin"],
    ]);
    assert.equal(rows[1]!.ip, "10.1.2.3");
    assert.equal(rows[1]!.request_id, "req-approve-1");
    assert.equal(rows[1]!.org_id, "org_1");
    assert.equal(rows[1]!.metadata.amount, 600);
  });

  it("records worker transitions as the system", async () => {
    const t = await makeTestApp();
    const { p } = await createAndApprove(t);
    const log = { info() {}, warn() {}, error() {} } as never;
    const worker = createPayoutWorker({
      db: t.db,
      log,
      clock: t.clock.now,
      provider: { send: async () => ({ outcome: "paid", reference: "prv_1" }) },
    });
    await worker.runOnce(5);
    const rows = await entries(t, "target_id = $1 AND actor_id IS NULL", [p.id]);
    assert.deepEqual(rows.map((r) => [r.action, r.actor_label]), [
      ["payout.processing", "system"],
      ["payout.paid", "system"],
    ]);
  });

  it("writes nothing when the action fails: the entry shares its transaction", async () => {
    const t = await makeTestApp();
    const { p, admin } = await createAndApprove(t);
    const before = (await entries(t)).length;
    // Stale version: the approve transaction rolls back, and so would its audit entry.
    const res = await t.app.inject({
      method: "POST",
      url: `/orgs/org_1/payouts/${p.id}/approve`,
      headers: { authorization: `Bearer ${admin}` },
      payload: { version: 1 },
    });
    assert.equal(res.statusCode, 409);
    assert.equal((await entries(t)).length, before);
  });
});

describe("audit log: append-only", () => {
  it("the app role can't UPDATE, DELETE or TRUNCATE it", async () => {
    const t = await makeTestApp();
    await t.login("admin@test.com");
    for (const sql of ["UPDATE audit_log SET action = 'x'", "DELETE FROM audit_log", "TRUNCATE audit_log"]) {
      await assert.rejects(t.db.query(sql), /permission denied/, sql);
    }
  });

  it("the trigger refuses it even for the owner", async () => {
    const t = await makeTestApp();
    await t.login("admin@test.com");
    for (const sql of ["UPDATE audit_log SET action = 'x'", "DELETE FROM audit_log", "TRUNCATE audit_log"]) {
      await assert.rejects(t.owner.query(sql), /append-only/, sql);
    }
    assert.equal((await entries(t)).length, 1);
  });
});

describe("audit log: API", () => {
  it("is admin-only", async () => {
    const t = await makeTestApp();
    assert.equal((await t.get("/orgs/org_1/audit", await t.tokenFor("multi@test.com"))).statusCode, 403);
    assert.equal((await t.get("/orgs/org_1/audit", await t.tokenFor("support@test.com"))).statusCode, 403);
    assert.equal((await t.get("/orgs/org_1/audit", await t.tokenFor("admin@test.com"))).statusCode, 200);
  });

  it("shows the org's entries plus logins of its members, newest first, with filters and a cursor", async () => {
    const t = await makeTestApp();
    await createAndApprove(t);
    await t.login("ghost@test.com", "nope"); // no org and no member: never shown
    await t.login("loner@test.com"); // not a member of org_1: not shown
    const admin = await t.tokenFor("admin@test.com");

    const all: AuditEntry[] = [];
    let cursor: string | null = null;
    do {
      const res = await t.get(`/orgs/org_1/audit?limit=2${cursor ? `&cursor=${cursor}` : ""}`, admin);
      const page = res.json() as { items: AuditEntry[]; nextCursor: string | null };
      all.push(...page.items);
      cursor = page.nextCursor;
    } while (cursor);
    assert.deepEqual(new Set(all.map((e) => e.id)).size, all.length, "no duplicates across pages");
    assert.ok(all.every((e, i) => i === 0 || all[i - 1]!.id > e.id), "newest first");
    assert.ok(!all.some((e) => e.metadata.email === "ghost@test.com"));
    assert.ok(!all.some((e) => e.actorId === "u_loner"));
    assert.ok(all.some((e) => e.action === "auth.login.succeeded" && e.actorId === "u_multi"));

    const approvals = (await t.get("/orgs/org_1/audit?action=payout.approved", admin)).json() as { items: AuditEntry[] };
    assert.deepEqual(approvals.items.map((e) => e.actorId), ["u_admin"]);
    const byMulti = (await t.get("/orgs/org_1/audit?actor=u_multi", admin)).json() as { items: AuditEntry[] };
    assert.ok(byMulti.items.length > 0 && byMulti.items.every((e) => e.actorId === "u_multi"));
    const later = (await t.get("/orgs/org_1/audit?from=2030-01-01", admin)).json() as { items: AuditEntry[] };
    assert.equal(later.items.length, 0);
    assert.equal((await t.get("/orgs/org_1/audit?from=2026-02-01&to=2026-01-01", admin)).statusCode, 400);
  });

  it("exports CSV, escapes formulas, and audits the export in the same transaction", async () => {
    const t = await makeTestApp();
    await createAndApprove(t);
    // A user agent that a spreadsheet would execute.
    await t.app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { email: "admin@test.com", password: PASSWORD },
      headers: { "user-agent": "=HYPERLINK(\"http://evil\")" },
    });
    const admin = await t.tokenFor("admin@test.com");
    const res = await t.app.inject({
      method: "POST",
      url: "/orgs/org_1/audit/export",
      headers: { authorization: `Bearer ${admin}` },
      payload: { action: "auth.login.succeeded" },
    });
    assert.equal(res.statusCode, 200);
    assert.match(String(res.headers["content-type"]), /text\/csv/);
    assert.match(String(res.headers["content-disposition"]), /attachment; filename="audit-org_1-/);
    const lines = res.body.trim().split("\r\n");
    assert.equal(lines[0], "id,createdAt,actorId,actorLabel,action,targetType,targetId,ip,userAgent,requestId,metadata");
    assert.ok(lines.some((l) => l.includes(`"'=HYPERLINK(""http://evil"")"`)), "formula neutralised and quoted");
    const exported = await entries(t, "action = 'audit.exported'");
    assert.equal(exported.length, 1);
    assert.equal(exported[0]!.metadata.rows, lines.length - 1);
    assert.equal((await t.app.inject({ method: "POST", url: "/orgs/org_1/audit/export", headers: { authorization: `Bearer ${await t.tokenFor("multi@test.com")}` }, payload: {} })).statusCode, 403);
  });
});
