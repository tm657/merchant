import type { Payout, PayoutDetail, Transaction } from "@mini-payments/shared";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { withTransaction } from "./db.js";
import { ledgerMismatches } from "./ledger.js";
import { publishOutboxBatch } from "./outbox.js";
import type { ProviderResult } from "./payouts/provider.js";
import { createPayoutWorker } from "./payouts/worker.js";
import { makeTestApp, makeTestDb } from "./test/helpers.js";

type T = Awaited<ReturnType<typeof makeTestApp>>;
const log = { info() {}, warn() {}, error() {} } as never;
const PAID: ProviderResult = { outcome: "paid", reference: "prv_1" };
const DECLINED: ProviderResult = { outcome: "declined", reason: "account_closed" };

/** Fails the test with the mismatching (org, currency) pairs if the invariant is broken. */
async function assertReconciles(t: T, step: string) {
  assert.deepEqual(await ledgerMismatches(t.db), [], `ledger out of balance after: ${step}`);
}

/**
 * The fixtures give org_1 a USD balance of 1000 with no ledger behind it. Book it as a
 * pay-in so the starting point is consistent, the way the seed does it.
 */
async function consistentApp() {
  const t = await makeTestApp();
  assert.deepEqual(await ledgerMismatches(t.db), [{ orgId: "org_1", currency: "USD", book: 1000, ledger: 0 }], "the check catches a gap");
  await t.db.query(
    `INSERT INTO transactions (id, org_id, merchant, amount, currency, status, created_at)
     VALUES ('txn_opening', 'org_1', 'Opening balance', 1000, 'USD', 'success', $1)`,
    [new Date(t.clock.now()).toISOString()],
  );
  await assertReconciles(t, "opening balance");
  return t;
}

async function payInWithBalance(t: T, amount: number, status: "success" | "pending" | "failed" = "success") {
  // What the simulator does: the row, and (only for success) the balance, in one transaction.
  const now = new Date(t.clock.now()).toISOString();
  await withTransaction(t.db, async (tx) => {
    await tx.query(
      `INSERT INTO transactions (id, org_id, merchant, amount, currency, status, created_at)
       VALUES ($1, 'org_1', 'Shop', $2, 'USD', $3, $4)`,
      [`txn_in_${Math.random().toString(36).slice(2)}`, amount, status, now],
    );
    if (status === "success") {
      await tx.query("UPDATE balances SET available = available + $1 WHERE org_id = 'org_1' AND currency = 'USD'", [amount]);
    }
  });
}

async function created(t: T, amount: number): Promise<Payout> {
  const res = await t.app.inject({
    method: "POST",
    url: "/orgs/org_1/payouts",
    headers: { authorization: `Bearer ${await t.tokenFor("multi@test.com")}`, "idempotency-key": `ledger-${Math.random().toString(36).slice(2)}` },
    payload: { amount, currency: "USD", beneficiaryName: `Beneficiary ${amount}`, accountNumber: "GB1234567890" },
  });
  assert.equal(res.statusCode, 201, res.body);
  return (res.json() as { payout: Payout }).payout;
}

async function decide(t: T, p: Payout, action: "approve" | "reject" | "cancel", token: string) {
  const res = await t.app.inject({
    method: "POST",
    url: `/orgs/org_1/payouts/${p.id}/${action}`,
    headers: { authorization: `Bearer ${token}` },
    payload: action === "reject" ? { version: p.version, reason: "no" } : { version: p.version },
  });
  return res;
}

function worker(t: T, results: ProviderResult[]) {
  let i = 0;
  return createPayoutWorker({
    db: t.db,
    log,
    clock: t.clock.now,
    provider: { send: async () => results[Math.min(i++, results.length - 1)]! },
  });
}

async function entries(t: T) {
  const { rows } = await t.db.query<{ type: string; amount: number; payout_id: string | null; status: string; merchant: string }>(
    "SELECT type, amount, payout_id, status, merchant FROM transactions WHERE type = 'payout' ORDER BY created_at, id",
  );
  return rows;
}

describe("ledger invariant: available + reserved = sum of successful entries", () => {
  it("holds after every step of the pay-in and pay-out lifecycle", async () => {
    const t = await consistentApp();
    const admin = await t.tokenFor("admin@test.com");
    const finance = await t.tokenFor("multi@test.com");

    await payInWithBalance(t, 5000);
    await payInWithBalance(t, 777, "pending");
    await payInWithBalance(t, 888, "failed");
    await assertReconciles(t, "pay-ins (pending and failed ones don't count)");

    const toPay = await created(t, 1200);
    const toFail = await created(t, 800);
    const toReject = await created(t, 300);
    const toCancel = await created(t, 200);
    await assertReconciles(t, "creating pay-outs");

    assert.equal((await decide(t, toPay, "approve", admin)).statusCode, 200);
    assert.equal((await decide(t, toFail, "approve", admin)).statusCode, 200);
    await assertReconciles(t, "approvals (available → reserved)");

    assert.equal((await decide(t, toReject, "reject", admin)).statusCode, 200);
    assert.equal((await decide(t, toCancel, "cancel", finance)).statusCode, 200);
    await assertReconciles(t, "reject and cancel");

    // Claim both, then pay one and decline the other.
    const w = worker(t, [PAID, DECLINED]);
    const claims = await w.claim(10);
    const payClaim = claims.find((c) => c.id === toPay.id)!;
    const failClaim = claims.find((c) => c.id === toFail.id)!;
    await assertReconciles(t, "claiming (approved → processing)");
    await w.complete(payClaim, { kind: "result", result: PAID });
    await assertReconciles(t, "paid");
    await w.complete(failClaim, { kind: "result", result: DECLINED });
    await assertReconciles(t, "failed (funds returned)");

    const { rows } = await t.db.query<{ available: number; reserved: number }>(
      "SELECT available, reserved FROM balances WHERE org_id = 'org_1' AND currency = 'USD'",
    );
    assert.deepEqual(rows[0], { available: 1000 + 5000 - 1200, reserved: 0 });
  });

  it("books exactly one negative entry per paid pay-out, and none for failed, rejected or cancelled", async () => {
    const t = await consistentApp();
    const admin = await t.tokenFor("admin@test.com");
    const paid = await created(t, 400);
    const failed = await created(t, 300);
    const rejected = await created(t, 100);
    await decide(t, paid, "approve", admin);
    await decide(t, failed, "approve", admin);
    await decide(t, rejected, "reject", admin);
    const w = worker(t, [PAID]);
    const claims = await w.claim(10);
    await w.complete(claims.find((c) => c.id === paid.id)!, { kind: "result", result: PAID });
    await w.complete(claims.find((c) => c.id === failed.id)!, { kind: "result", result: DECLINED });

    assert.deepEqual(await entries(t), [{ type: "payout", amount: -400, payout_id: paid.id, status: "success", merchant: "Beneficiary 400" }]);
    await assertReconciles(t, "mixed outcomes");
  });

  it("stays balanced when approvals race and the worker retries", async () => {
    const t = await consistentApp();
    const admin = await t.tokenFor("admin@test.com");
    const [a, b] = [await created(t, 700), await created(t, 700)];
    const results = await Promise.all([decide(t, a, "approve", admin), decide(t, b, "approve", admin)]);
    assert.deepEqual(results.map((r) => r.statusCode).sort(), [200, 409]);
    await assertReconciles(t, "racing approvals");

    const w = createPayoutWorker({
      db: t.db,
      log,
      clock: t.clock.now,
      backoffBaseMs: 1000,
      random: () => 0.5,
      provider: (() => {
        let calls = 0;
        return {
          send: async () => {
            if (calls++ === 0) throw new Error("timeout");
            return PAID;
          },
        };
      })(),
    });
    await w.runOnce(5);
    await assertReconciles(t, "transient failure, retry scheduled");
    t.clock.advance(1000);
    await w.runOnce(5);
    await assertReconciles(t, "paid on retry");
    assert.equal((await entries(t)).length, 1);
  });

  it("is enforced by constraints: no positive pay-out entry, no second entry for a pay-out", async () => {
    const t = await consistentApp();
    const p = await created(t, 100);
    const insert = (id: string, amount: number, type = "payout", payoutId: string | null = p.id) =>
      t.db.query(
        `INSERT INTO transactions (id, org_id, type, payout_id, merchant, amount, currency, status, created_at)
         VALUES ($1, 'org_1', $2, $3, 'x', $4, 'USD', 'success', now())`,
        [id, type, payoutId, amount],
      );
    await assert.rejects(insert("t1", 100), { code: "23514" }, "a pay-out entry must be negative");
    await assert.rejects(insert("t2", -1, "payin", null), { code: "23514" }, "a pay-in can't be negative");
    await assert.rejects(insert("t3", -1, "payout", null), { code: "23514" }, "a pay-out entry needs its pay-out");
    await insert("t4", -100);
    await assert.rejects(insert("t5", -100), { code: "23505" }, "one entry per pay-out");
  });
});

describe("ledger migration backfill", () => {
  it("books pay-outs that were paid before the migration, dated when they were paid", async () => {
    // Stop before the ledger migration (the 4th), create a paid pay-out the old way, then migrate.
    const { owner, migrateRest } = await makeTestDb({ migrations: 3 });
    await owner.query("INSERT INTO orgs (id, name) VALUES ('org_1', 'Org')");
    await owner.query("INSERT INTO users (id, email, name, password_hash, created_at) VALUES ('u1', 'a@b.co', 'A', 'x', now()), ('u2', 'c@d.co', 'C', 'x', now())");
    await owner.query("INSERT INTO balances (org_id, currency, available, reserved, updated_at) VALUES ('org_1', 'USD', 600, 0, now())");
    await owner.query("INSERT INTO transactions (id, org_id, merchant, amount, currency, status, created_at) VALUES ('t_in', 'org_1', 'Shop', 1000, 'USD', 'success', now())");
    await owner.query(
      `INSERT INTO payouts (id, org_id, amount, currency, beneficiary_name, account_number, status, version, created_by, decided_by, created_at, updated_at)
       VALUES ('po_old', 'org_1', 400, 'USD', 'Old Payee', 'GB1234', 'paid', 4, 'u1', 'u2', now(), '2026-03-03T03:03:03.333Z'),
              ('po_failed', 'org_1', 50, 'USD', 'Failed Payee', 'GB1234', 'failed', 4, 'u1', 'u2', now(), now())`,
    );
    await owner.query("INSERT INTO payout_events (payout_id, from_status, to_status, created_at) VALUES ('po_old', 'processing', 'paid', '2026-03-02T02:02:02.222Z')");
    assert.equal((await ledgerMismatches(owner)).length, 1, "the gap exists before the migration");

    await migrateRest();
    const { rows } = await owner.query<{ id: string; amount: number; merchant: string; created_at: string; payout_id: string }>(
      "SELECT id, amount, merchant, created_at, payout_id FROM transactions WHERE type = 'payout'",
    );
    assert.deepEqual(rows, [
      { id: "txn_po_old", amount: -400, merchant: "Old Payee", created_at: "2026-03-02T02:02:02.222Z", payout_id: "po_old" },
    ]);
    assert.deepEqual(await ledgerMismatches(owner), []);
  });
});

describe("transactions API with pay-out entries", () => {
  it("returns type and payoutId, filters by type, and pages negative amounts in order", async () => {
    const t = await consistentApp();
    const admin = await t.tokenFor("admin@test.com");
    const p = await created(t, 450);
    await decide(t, p, "approve", admin);
    const w = worker(t, [PAID]);
    await w.runOnce(5);
    // The worker announced the new ledger row for open Transactions pages.
    const { rows: outbox } = await t.db.query<{ type: string }>("SELECT type FROM outbox WHERE type = 'transactions'");
    assert.equal(outbox.length, 1);
    await publishOutboxBatch(t.db, t.redis, { prefix: t.redisPrefix });

    const payouts = (await t.get("/orgs/org_1/transactions?type=payout", admin)).json() as { items: Transaction[] };
    assert.deepEqual(
      payouts.items.map((x) => ({ type: x.type, amount: x.amount, payoutId: x.payoutId, merchant: x.merchant, status: x.status })),
      [{ type: "payout", amount: -450, payoutId: p.id, merchant: "Beneficiary 450", status: "success" }],
    );
    const payins = (await t.get("/orgs/org_1/transactions?type=payin", admin)).json() as { items: Transaction[] };
    assert.ok(payins.items.length > 0 && payins.items.every((x) => x.type === "payin" && x.payoutId === null));
    assert.equal((await t.get("/orgs/org_1/transactions?type=refund", admin)).statusCode, 400);

    // Keyset paging across negative and positive amounts, one row per page.
    const seen: number[] = [];
    let cursor: string | null = null;
    do {
      const res = await t.get(`/orgs/org_1/transactions?sort=amount&dir=asc&limit=1${cursor ? `&cursor=${cursor}` : ""}`, admin);
      const page = res.json() as { items: Transaction[]; nextCursor: string | null };
      seen.push(...page.items.map((x) => x.amount));
      cursor = page.nextCursor;
    } while (cursor);
    assert.deepEqual(seen, [-450, 1000]);
  });
});

describe("pay-out timeline names", () => {
  it("shows each actor's display name, never an email or an id", async () => {
    const t = await consistentApp();
    const admin = await t.tokenFor("admin@test.com");
    const p = await created(t, 100);
    await decide(t, p, "approve", admin);
    const detail = (await t.get(`/orgs/org_1/payouts/${p.id}`, admin)).json() as PayoutDetail;
    assert.deepEqual(detail.timeline.map((e) => e.actor?.name ?? null), ["Max Multi", "Ada Admin"]);
    assert.equal(detail.payout.createdBy.name, "Max Multi");
    assert.equal(detail.payout.decidedBy?.name, "Ada Admin");
    assert.ok(!JSON.stringify(detail.timeline).includes("@test.com"));
  });
});
