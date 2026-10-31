import { canTransition, PAYOUT_ACTIONS, type Payout, type PayoutAction, type PayoutStatus } from "@mini-payments/shared";
import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { ledgerMismatches } from "../ledger.js";
import { makeTestApp } from "../test/helpers.js";
import { createPayoutWorker } from "./worker.js";

type T = Awaited<ReturnType<typeof makeTestApp>>;
const log = { info() {}, warn() {}, error() {} } as never;

const ACTION_TARGET: Record<PayoutAction, PayoutStatus> = { approve: "approved", reject: "rejected", cancel: "cancelled" };

async function setup() {
  const t = await makeTestApp();
  // Enough funds for every approval below, booked so the ledger stays consistent.
  await t.db.query("UPDATE balances SET available = 1000000 WHERE org_id = 'org_1'");
  await t.db.query(
    `INSERT INTO transactions (id, org_id, merchant, amount, currency, status, created_at)
     VALUES ('txn_opening', 'org_1', 'Opening', 1000000, 'USD', 'success', now())`,
  );
  return { t, admin: await t.tokenFor("admin@test.com"), finance: await t.tokenFor("multi@test.com") };
}

async function create(t: T, finance: string): Promise<Payout> {
  const res = await t.app.inject({
    method: "POST",
    url: "/orgs/org_1/payouts",
    headers: { authorization: `Bearer ${finance}`, "idempotency-key": `sm-${Math.random().toString(36).slice(2)}` },
    payload: { amount: 100, currency: "USD", beneficiaryName: "Acme", accountNumber: "GB1234567890" },
  });
  return (res.json() as { payout: Payout }).payout;
}

function act(t: T, token: string, id: string, action: PayoutAction, version: number) {
  return t.app.inject({
    method: "POST",
    url: `/orgs/org_1/payouts/${id}/${action}`,
    headers: { authorization: `Bearer ${token}` },
    payload: action === "reject" ? { version, reason: "no" } : { version },
  });
}

async function current(t: T, id: string): Promise<{ status: PayoutStatus; version: number }> {
  const { rows } = await t.db.query<{ status: PayoutStatus; version: number }>("SELECT status, version FROM payouts WHERE id = $1", [id]);
  return rows[0]!;
}

/** Drives a fresh pay-out into `status` through the real API and worker. */
async function payoutIn(t: T, admin: string, finance: string, status: PayoutStatus): Promise<string> {
  const p = await create(t, finance);
  if (status === "pending_approval") return p.id;
  if (status === "rejected" || status === "cancelled") {
    await act(t, status === "rejected" ? admin : finance, p.id, status === "rejected" ? "reject" : "cancel", 1);
    return p.id;
  }
  await act(t, admin, p.id, "approve", 1);
  if (status === "approved") return p.id;
  const worker = createPayoutWorker({
    db: t.db,
    log,
    clock: t.clock.now,
    provider: { send: async () => (status === "failed" ? { outcome: "declined", reason: "x" } : { outcome: "paid", reference: "r" }) },
  });
  const [claim] = await worker.claim(1);
  if (status === "processing") return p.id;
  await worker.complete(claim!, { kind: "result", result: status === "paid" ? { outcome: "paid", reference: "r" } : { outcome: "declined", reason: "x" } });
  return p.id;
}

describe("pay-out state machine through the API", () => {
  const STATES: PayoutStatus[] = ["pending_approval", "approved", "processing", "paid", "failed", "rejected", "cancelled"];

  for (const state of STATES) {
    const refused = PAYOUT_ACTIONS.filter((a) => !canTransition(state, ACTION_TARGET[a]));
    if (refused.length === 0) continue;
    it(`refuses ${refused.join(", ")} from ${state} with 409 invalid_transition`, async () => {
      const { t, admin, finance } = await setup();
      const id = await payoutIn(t, admin, finance, state);
      assert.equal((await current(t, id)).status, state);
      for (const action of refused) {
        const { version } = await current(t, id);
        // The right person and the current version: only the transition itself is wrong.
        const res = await act(t, action === "cancel" ? finance : admin, id, action, version);
        assert.equal(res.statusCode, 409, `${action} from ${state}`);
        assert.deepEqual(res.json(), { error: "invalid_transition" });
      }
      assert.equal((await current(t, id)).status, state, "nothing changed");
      assert.deepEqual(await ledgerMismatches(t.db), []);
    });
  }

  it("accepts every allowed transition exactly as documented", async () => {
    const { t, admin, finance } = await setup();
    for (const action of PAYOUT_ACTIONS) {
      const id = await payoutIn(t, admin, finance, "pending_approval");
      const res = await act(t, action === "cancel" ? finance : admin, id, action, 1);
      assert.equal(res.statusCode, 200, action);
      assert.deepEqual(await current(t, id), { status: ACTION_TARGET[action], version: 2 });
    }
  });
});

describe("concurrent approvals of the same pay-out", () => {
  it("exactly one of many simultaneous approvals wins, and funds are reserved once", async () => {
    const { t, admin, finance } = await setup();
    const p = await create(t, finance);
    const results = await Promise.all(Array.from({ length: 8 }, () => act(t, admin, p.id, "approve", 1)));
    const codes = results.map((r) => r.statusCode).sort();
    assert.deepEqual(codes, [200, 409, 409, 409, 409, 409, 409, 409]);
    for (const r of results.filter((x) => x.statusCode === 409)) assert.deepEqual(r.json(), { error: "version_conflict" });
    const { rows } = await t.db.query<{ reserved: number }>("SELECT reserved FROM balances WHERE org_id = 'org_1' AND currency = 'USD'");
    assert.equal(rows[0]!.reserved, 100);
    const events = await t.db.query("SELECT 1 FROM payout_events WHERE payout_id = $1 AND to_status = 'approved'", [p.id]);
    assert.equal(events.rowCount, 1);
    assert.deepEqual(await ledgerMismatches(t.db), []);
  });

  it("an approval racing a cancel: exactly one of them happens", async () => {
    const { t, admin, finance } = await setup();
    for (let i = 0; i < 5; i++) {
      const p = await create(t, finance);
      const [approve, cancel] = await Promise.all([act(t, admin, p.id, "approve", 1), act(t, finance, p.id, "cancel", 1)]);
      assert.deepEqual([approve.statusCode, cancel.statusCode].sort(), [200, 409]);
      assert.ok(["approved", "cancelled"].includes((await current(t, p.id)).status));
    }
    assert.deepEqual(await ledgerMismatches(t.db), []);
  });
});
