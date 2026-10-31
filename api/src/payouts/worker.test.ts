import type { Payout, PayoutDetail } from "@mini-payments/shared";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { publishOutboxBatch } from "../outbox.js";
import { deadRedis, fakeClock, makeTestApp, makeTestRedis } from "../test/helpers.js";
import { openStream } from "../test/sse.js";
import {
  createSimulatedProvider,
  TransientProviderError,
  type PayoutProvider,
  type ProviderResult,
} from "./provider.js";
import { createPayoutWorker } from "./worker.js";

type T = Awaited<ReturnType<typeof makeTestApp>>;

const silent = { info() {}, warn() {}, error() {}, debug() {}, fatal() {}, trace() {}, child: () => silent, level: "silent" };
const log = silent as never;

/** A provider that answers from a script, one entry per call (the last one repeats). */
function scripted(...answers: (ProviderResult | "transient")[]): PayoutProvider & { calls: number } {
  const p = {
    calls: 0,
    async send() {
      const answer = answers[Math.min(p.calls++, answers.length - 1)]!;
      if (answer === "transient") throw new TransientProviderError("timeout");
      return answer;
    },
  };
  return p;
}
const PAID: ProviderResult = { outcome: "paid", reference: "prv_1" };
const DECLINED: ProviderResult = { outcome: "declined", reason: "account_closed" };

async function approvedPayout(t: T, amount = 600): Promise<Payout> {
  const finance = await t.tokenFor("multi@test.com");
  const admin = await t.tokenFor("admin@test.com");
  const res = await t.app.inject({
    method: "POST",
    url: "/orgs/org_1/payouts",
    headers: { authorization: `Bearer ${finance}`, "idempotency-key": `k-${Math.random().toString(36).slice(2)}` },
    payload: { amount, currency: "USD", beneficiaryName: "Acme", accountNumber: "GB1234567890" },
  });
  const created = (res.json() as { payout: Payout }).payout;
  const approved = await t.app.inject({
    method: "POST",
    url: `/orgs/org_1/payouts/${created.id}/approve`,
    headers: { authorization: `Bearer ${admin}` },
    payload: { version: 1 },
  });
  assert.equal(approved.statusCode, 200, approved.body);
  return (approved.json() as { payout: Payout }).payout;
}

async function state(t: T, id: string) {
  const { rows } = await t.db.query<{ status: string; attempts: number; failure_reason: string | null }>(
    "SELECT status, attempts, failure_reason FROM payouts WHERE id = $1",
    [id],
  );
  const { rows: b } = await t.db.query<{ available: number; reserved: number }>(
    "SELECT available, reserved FROM balances WHERE org_id = 'org_1' AND currency = 'USD'",
  );
  return { ...rows[0]!, balance: b[0]! };
}

describe("pay-out worker", () => {
  it("pays: releases the reservation and records the timeline", async () => {
    const t = await makeTestApp();
    const p = await approvedPayout(t);
    const worker = createPayoutWorker({ db: t.db, provider: scripted(PAID), log, clock: t.clock.now });
    assert.equal(await worker.runOnce(10), 1);

    const s = await state(t, p.id);
    assert.equal(s.status, "paid");
    assert.deepEqual(s.balance, { available: 400, reserved: 0 });
    const detail = (await t.get(`/orgs/org_1/payouts/${p.id}`, await t.tokenFor("admin@test.com"))).json() as PayoutDetail;
    assert.deepEqual(
      detail.timeline.map((e) => `${e.fromStatus}->${e.toStatus}:${e.actor?.id ?? "system"}`),
      ["null->pending_approval:u_multi", "pending_approval->approved:u_admin", "approved->processing:system", "processing->paid:system"],
    );
  });

  it("fails on a decline and returns the funds to available", async () => {
    const t = await makeTestApp();
    const p = await approvedPayout(t);
    const worker = createPayoutWorker({ db: t.db, provider: scripted(DECLINED), log, clock: t.clock.now });
    await worker.runOnce(10);
    const s = await state(t, p.id);
    assert.equal(s.status, "failed");
    assert.equal(s.failure_reason, "declined: account_closed");
    assert.deepEqual(s.balance, { available: 1000, reserved: 0 });
  });

  it("retries transient errors with backoff, then pays", async () => {
    const t = await makeTestApp();
    const p = await approvedPayout(t);
    const provider = scripted("transient", PAID);
    const worker = createPayoutWorker({ db: t.db, provider, log, clock: t.clock.now, backoffBaseMs: 1000, random: () => 0.5 });

    await worker.runOnce(10);
    assert.equal((await state(t, p.id)).status, "processing");
    assert.equal(await worker.runOnce(10), 0, "not due yet: backoff");
    t.clock.advance(1000);
    assert.equal(await worker.runOnce(10), 1);

    const s = await state(t, p.id);
    assert.equal(s.status, "paid");
    assert.equal(s.attempts, 2);
    assert.equal(provider.calls, 2);
    assert.deepEqual(s.balance, { available: 400, reserved: 0 });
  });

  it("gives up after the last attempt and returns the funds", async () => {
    const t = await makeTestApp();
    const p = await approvedPayout(t);
    const worker = createPayoutWorker({ db: t.db, provider: scripted("transient"), log, clock: t.clock.now, maxAttempts: 2 });
    await worker.runOnce(10);
    t.clock.advance(60_000);
    await worker.runOnce(10);
    const s = await state(t, p.id);
    assert.equal(s.status, "failed");
    assert.match(s.failure_reason!, /^provider_unavailable: timeout after 2 attempts/);
    assert.deepEqual(s.balance, { available: 1000, reserved: 0 });
  });

  it("never lets two workers claim the same row (SKIP LOCKED)", async () => {
    const t = await makeTestApp();
    await t.db.query("UPDATE balances SET available = 1000000 WHERE org_id = 'org_1'");
    const ids = new Set<string>();
    for (let i = 0; i < 10; i++) ids.add((await approvedPayout(t, 100)).id);

    const a = createPayoutWorker({ db: t.db, provider: scripted(PAID), log, clock: t.clock.now });
    const b = createPayoutWorker({ db: t.db, provider: scripted(PAID), log, clock: t.clock.now });
    const [ca, cb] = await Promise.all([a.claim(6), b.claim(6)]);
    const claimed = [...ca, ...cb].map((c) => c.id);
    assert.equal(new Set(claimed).size, claimed.length, "no row claimed twice");
    assert.deepEqual(new Set(claimed), ids, "every row claimed");
    assert.equal((await a.claim(10)).length, 0, "claimed rows are leased");
  });

  it("reclaims a crashed worker's row after its lease, and ignores the stale result", async () => {
    const t = await makeTestApp();
    const p = await approvedPayout(t);
    const crashed = createPayoutWorker({ db: t.db, provider: scripted(PAID), log, clock: t.clock.now, leaseMs: 30_000 });
    const [claim] = await crashed.claim(1);
    assert.ok(claim);

    t.clock.advance(30_001);
    const healthy = createPayoutWorker({ db: t.db, provider: scripted(PAID), log, clock: t.clock.now });
    const [again] = await healthy.claim(1);
    assert.equal(again?.id, p.id);
    assert.equal(again?.attempts, 2);

    // The first worker wakes up late: its result is discarded.
    assert.equal(await crashed.complete(claim, { kind: "result", result: DECLINED }), "lost");
    assert.equal(await healthy.complete(again!, { kind: "result", result: PAID }), "paid");
    const s = await state(t, p.id);
    assert.equal(s.status, "paid");
    assert.deepEqual(s.balance, { available: 400, reserved: 0 }, "funds moved exactly once");
  });
});

describe("simulated provider", () => {
  it("is idempotent per pay-out and follows its failure rates", async () => {
    const { redis, prefix } = await makeTestRedis();
    let roll = 0.99;
    const provider = createSimulatedProvider({
      redis,
      prefix,
      minLatencyMs: 0,
      maxLatencyMs: 0,
      declineRate: 0.05,
      transientRate: 0.05,
      random: () => roll,
    });
    const req = { payoutId: "po_x", amount: 1, currency: "USD" as const, accountNumber: "GB1234" };
    const first = await provider.send(req);
    assert.equal(first.outcome, "paid");
    roll = 0.07; // would now be a decline...
    assert.deepEqual(await provider.send(req), first, "...but the stored answer wins");
    assert.equal((await provider.send({ ...req, payoutId: "po_y" })).outcome, "declined");
    roll = 0.01;
    await assert.rejects(provider.send({ ...req, payoutId: "po_z" }), TransientProviderError);
  });
});

describe("outbox", () => {
  it("publishes committed events to SSE clients through Redis", async () => {
    const clock = fakeClock(Date.now());
    const t = await makeTestApp(clock);
    const url = await t.app.listen({ port: 0, host: "127.0.0.1" });
    const stream = await openStream(url, await t.tokenFor("support@test.com"));
    try {
      const p = await approvedPayout(t);
      // 2 SSE pay-out events, 1 balance event, 2 webhook events (fanned out, not sent to Redis).
      assert.equal(await publishOutboxBatch(t.db, t.redis, { prefix: t.redisPrefix }), 5);
      assert.deepEqual(await stream.next("payout"), { payoutId: p.id, status: "pending_approval", version: 1 });
      assert.deepEqual(await stream.next("payout"), { payoutId: p.id, status: "approved", version: 2 });
      // Support can't read balances, so the balance event never reaches them.
      await assert.rejects(stream.next("balance", 300));
      assert.equal(await publishOutboxBatch(t.db, t.redis, { prefix: t.redisPrefix }), 0, "nothing sent twice");
    } finally {
      stream.close();
    }
  });

  it("keeps events unpublished when Redis is down, and sends them later", async () => {
    const t = await makeTestApp();
    await approvedPayout(t);
    const dead = deadRedis();
    await assert.rejects(publishOutboxBatch(t.db, dead.redis, { prefix: t.redisPrefix }));
    const { rows } = await t.db.query("SELECT 1 FROM outbox WHERE published_at IS NULL");
    // 2 SSE pay-out events, 1 balance event, 2 webhook events: all still waiting.
    assert.equal(rows.length, 5);
    assert.equal(await publishOutboxBatch(t.db, t.redis, { prefix: t.redisPrefix }), 5);
  });
});
