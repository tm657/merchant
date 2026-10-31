import { canTransition, PAYOUT_STATUSES, parseMoneyInput, type Payout, type PayoutDetail } from "@mini-payments/shared";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { fakeClock, makeTestApp } from "../test/helpers.js";

type T = Awaited<ReturnType<typeof makeTestApp>>;

const BODY = { amount: 600, currency: "USD", beneficiaryName: "Acme", accountNumber: "gb12 3456 7890", reference: "inv 1" };

async function setup() {
  const t = await makeTestApp();
  const [admin, finance, support] = await Promise.all([
    t.tokenFor("admin@test.com"),
    t.tokenFor("multi@test.com"), // finance in org_1
    t.tokenFor("support@test.com"),
  ]);
  return { t, admin, finance, support };
}

function post(t: T, url: string, token: string, payload: unknown, headers: Record<string, string> = {}) {
  return t.app.inject({ method: "POST", url, payload: payload as object, headers: { authorization: `Bearer ${token}`, ...headers } });
}

function create(t: T, token: string, body: object = BODY, key = `key-${Math.random().toString(36).slice(2)}`, org = "org_1") {
  return post(t, `/orgs/${org}/payouts`, token, body, { "idempotency-key": key });
}

async function created(t: T, token: string, body: object = BODY): Promise<Payout> {
  const res = await create(t, token, body);
  assert.equal(res.statusCode, 201, res.body);
  return (res.json() as { payout: Payout }).payout;
}

const decide = (t: T, token: string, id: string, action: string, payload: object) =>
  post(t, `/orgs/org_1/payouts/${id}/${action}`, token, payload);

async function balance(t: T, currency = "USD") {
  const { rows } = await t.db.query<{ available: number; reserved: number }>(
    "SELECT available, reserved FROM balances WHERE org_id = 'org_1' AND currency = $1",
    [currency],
  );
  return rows[0];
}

describe("pay-out state machine (shared)", () => {
  it("allows exactly the documented transitions", () => {
    const allowed = PAYOUT_STATUSES.flatMap((from) =>
      PAYOUT_STATUSES.filter((to) => canTransition(from, to)).map((to) => `${from}->${to}`),
    );
    assert.deepEqual(allowed.sort(), [
      "approved->processing",
      "pending_approval->approved",
      "pending_approval->cancelled",
      "pending_approval->rejected",
      "processing->failed",
      "processing->paid",
    ]);
  });

  it("parses typed money without floats, by currency exponent", () => {
    assert.deepEqual(parseMoneyInput("1,234.56", "USD"), { ok: true, amount: 123_456 });
    assert.deepEqual(parseMoneyInput("15,000", "IDR"), { ok: true, amount: 15_000 });
    assert.equal(parseMoneyInput("15000.5", "IDR").ok, false);
    assert.equal(parseMoneyInput("1.234", "USD").ok, false);
    assert.equal(parseMoneyInput("0.00", "USD").ok, false);
  });
});

describe("pay-out permissions", () => {
  it("lets every role read, finance and admin create, and only admin approve or reject", async () => {
    const { t, admin, finance, support } = await setup();
    assert.equal((await t.get("/orgs/org_1/payouts", support)).statusCode, 200);
    assert.equal((await create(t, support)).statusCode, 403);
    const p = await created(t, finance);
    assert.equal((await decide(t, finance, p.id, "approve", { version: 1 })).statusCode, 403);
    assert.equal((await decide(t, support, p.id, "reject", { version: 1, reason: "no" })).statusCode, 403);
    assert.equal((await decide(t, admin, p.id, "approve", { version: 1 })).statusCode, 200);
  });

  it("refuses self-approval with 403, and the database refuses it too", async () => {
    const { t, admin } = await setup();
    const p = await created(t, admin);
    const res = await decide(t, admin, p.id, "approve", { version: 1 });
    assert.equal(res.statusCode, 403);
    assert.deepEqual(res.json(), { error: "self_approval_forbidden" });
    assert.equal((await decide(t, admin, p.id, "reject", { version: 1, reason: "x" })).statusCode, 403);
    await assert.rejects(t.db.query("UPDATE payouts SET decided_by = created_by WHERE id = $1", [p.id]), { code: "23514" });
  });
});

describe("pay-out creation", () => {
  it("requires an Idempotency-Key", async () => {
    const { t, finance } = await setup();
    const res = await post(t, "/orgs/org_1/payouts", finance, BODY);
    assert.equal(res.statusCode, 400);
    assert.deepEqual(res.json(), { error: "idempotency_key_required" });
  });

  it("returns a masked account number and normalizes input", async () => {
    const { t, finance } = await setup();
    const p = await created(t, finance);
    assert.equal(p.accountLast4, "7890");
    assert.equal(p.status, "pending_approval");
    assert.ok(!JSON.stringify(p).includes("GB123456"));
  });

  it("replays the stored response for the same key and body", async () => {
    const { t, finance } = await setup();
    const first = await create(t, finance, BODY, "same-key-1");
    // Same meaning, different spelling: still the same request.
    const again = await create(t, finance, { ...BODY, accountNumber: "GB1234567890" }, "same-key-1");
    assert.equal(again.statusCode, 201);
    assert.equal(again.headers["idempotent-replayed"], "true");
    assert.deepEqual(again.json(), first.json());
    const { rows } = await t.db.query("SELECT id FROM payouts");
    assert.equal(rows.length, 1);
  });

  it("returns 422 for the same key with a different body, or from another user", async () => {
    const { t, finance, admin } = await setup();
    await create(t, finance, BODY, "same-key-2");
    const changed = await create(t, finance, { ...BODY, amount: 601 }, "same-key-2");
    assert.equal(changed.statusCode, 422);
    assert.deepEqual(changed.json(), { error: "idempotency_key_reused" });
    assert.equal((await create(t, admin, BODY, "same-key-2")).statusCode, 422);
  });

  it("creates exactly one pay-out when the same request races", async () => {
    const { t, finance } = await setup();
    const results = await Promise.all(Array.from({ length: 10 }, () => create(t, finance, BODY, "racing-key")));
    assert.ok(results.every((r) => r.statusCode === 201), results.map((r) => r.statusCode).join(","));
    assert.equal(new Set(results.map((r) => (r.json() as { payout: Payout }).payout.id)).size, 1);
    assert.equal((await t.db.query("SELECT 1 FROM payouts")).rowCount, 1);
  });

  it("limits new pay-outs per user with 429, but never blocks replays", async () => {
    const { t, finance } = await setup();
    for (let i = 0; i < 10; i++) assert.equal((await create(t, finance, BODY, `rate-key-${i}`)).statusCode, 201);
    const limited = await create(t, finance, BODY, "rate-key-new");
    assert.equal(limited.statusCode, 429);
    assert.equal(limited.headers["retry-after"], "60");
    assert.equal((await create(t, finance, BODY, "rate-key-3")).statusCode, 201, "a replay still works");
  });
});

describe("pay-out approval", () => {
  it("moves funds from available to reserved in the same transaction", async () => {
    const { t, admin, finance } = await setup();
    const p = await created(t, finance);
    const res = await decide(t, admin, p.id, "approve", { version: 1 });
    assert.equal(res.statusCode, 200);
    const approved = (res.json() as { payout: Payout }).payout;
    assert.equal(approved.status, "approved");
    assert.equal(approved.version, 2);
    assert.equal(approved.decidedBy?.id, "u_admin");
    assert.deepEqual(await balance(t), { available: 400, reserved: 600 });
    const { rows } = await t.db.query<{ type: string }>("SELECT type FROM outbox ORDER BY id");
    assert.deepEqual(rows.map((r) => r.type), ["payout", "payout", "balance"]);
  });

  it("returns 409 for insufficient funds and for a currency with no balance", async () => {
    const { t, admin, finance } = await setup();
    const big = await created(t, finance, { ...BODY, amount: 1001 });
    const res = await decide(t, admin, big.id, "approve", { version: 1 });
    assert.equal(res.statusCode, 409);
    assert.deepEqual(res.json(), { error: "insufficient_funds" });
    const idr = await created(t, finance, { ...BODY, currency: "IDR", amount: 1 });
    assert.equal((await decide(t, admin, idr.id, "approve", { version: 1 })).statusCode, 409);
    assert.deepEqual(await balance(t), { available: 1000, reserved: 0 });
  });

  it("never overdraws when approvals race for the same balance", async () => {
    const { t, admin, finance } = await setup();
    const [a, b] = [await created(t, finance), await created(t, finance)];
    const results = await Promise.all([
      decide(t, admin, a.id, "approve", { version: 1 }),
      decide(t, admin, b.id, "approve", { version: 1 }),
    ]);
    assert.deepEqual(results.map((r) => r.statusCode).sort(), [200, 409]);
    assert.deepEqual(await balance(t), { available: 400, reserved: 600 });
  });

  it("returns 409 version_conflict for a stale version and invalid_transition for a decided one", async () => {
    const { t, admin, finance } = await setup();
    const p = await created(t, finance);
    await decide(t, admin, p.id, "approve", { version: 1 });
    const stale = await decide(t, admin, p.id, "approve", { version: 1 });
    assert.equal(stale.statusCode, 409);
    assert.deepEqual(stale.json(), { error: "version_conflict" });
    const again = await decide(t, admin, p.id, "reject", { version: 2, reason: "late" });
    assert.deepEqual(again.json(), { error: "invalid_transition" });
  });
});

describe("pay-out rejection and cancellation", () => {
  it("requires a reason, then rejects without touching funds", async () => {
    const { t, admin, finance } = await setup();
    const p = await created(t, finance);
    assert.equal((await decide(t, admin, p.id, "reject", { version: 1, reason: "  " })).statusCode, 400);
    const res = await decide(t, admin, p.id, "reject", { version: 1, reason: "Wrong beneficiary" });
    assert.equal(res.statusCode, 200);
    assert.equal((res.json() as { payout: Payout }).payout.rejectReason, "Wrong beneficiary");
    assert.deepEqual(await balance(t), { available: 1000, reserved: 0 });
    assert.deepEqual((await decide(t, admin, p.id, "approve", { version: 2 })).json(), { error: "invalid_transition" });
  });

  it("lets only the creator cancel, and only while pending", async () => {
    const { t, admin, finance } = await setup();
    const p = await created(t, finance);
    assert.deepEqual((await decide(t, admin, p.id, "cancel", { version: 1 })).json(), { error: "not_creator" });
    assert.equal((await decide(t, finance, p.id, "cancel", { version: 1 })).statusCode, 200);

    const q = await created(t, finance);
    await decide(t, admin, q.id, "approve", { version: 1 });
    assert.deepEqual((await decide(t, finance, q.id, "cancel", { version: 2 })).json(), { error: "invalid_transition" });
  });
});

describe("pay-out list and detail", () => {
  it("pages newest first with a cursor and filters by status", async () => {
    const { t, admin, finance } = await setup();
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      ids.push((await created(t, finance, { ...BODY, amount: 10 + i })).id);
      t.clock.advance(1000);
    }
    await decide(t, admin, ids[1]!, "approve", { version: 1 });

    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const res = await t.get(`/orgs/org_1/payouts?limit=2${cursor ? `&cursor=${cursor}` : ""}`, finance);
      const page = res.json() as { items: Payout[]; nextCursor: string | null };
      seen.push(...page.items.map((p) => p.id));
      cursor = page.nextCursor;
    } while (cursor);
    assert.deepEqual(seen, [...ids].reverse());

    const approved = (await t.get("/orgs/org_1/payouts?status=approved", finance)).json() as { items: Payout[] };
    assert.deepEqual(approved.items.map((p) => p.id), [ids[1]]);
    assert.equal((await t.get("/orgs/org_1/payouts?status=nope", finance)).statusCode, 400);
    assert.equal((await t.get("/orgs/org_1/payouts?cursor=zzz", finance)).statusCode, 400);
  });

  it("returns one pay-out with its timeline, and 404 outside the org", async () => {
    const { t, admin, finance } = await setup();
    const p = await created(t, finance);
    await decide(t, admin, p.id, "approve", { version: 1 });
    const res = await t.get(`/orgs/org_1/payouts/${p.id}`, finance);
    const detail = res.json() as PayoutDetail;
    assert.deepEqual(
      detail.timeline.map((e) => [e.fromStatus, e.toStatus, e.actor?.id ?? null]),
      [
        [null, "pending_approval", "u_multi"],
        ["pending_approval", "approved", "u_admin"],
      ],
    );
    assert.equal((await t.get("/orgs/org_1/payouts/po_missing", finance)).statusCode, 404);

    // multi is admin in org_2: its pay-out isn't reachable through org_1.
    const other = await create(t, finance, BODY, "org2-key", "org_2");
    const otherId = (other.json() as { payout: Payout }).payout.id;
    assert.equal((await t.get(`/orgs/org_1/payouts/${otherId}`, finance)).statusCode, 404);
    assert.equal((await decide(t, admin, otherId, "approve", { version: 1 })).statusCode, 404);
  });
});

describe("pay-out clock", () => {
  it("uses the injected clock for timestamps", async () => {
    const t = await makeTestApp(fakeClock(Date.parse("2026-05-05T05:05:05.005Z")));
    const p = await created(t, await t.tokenFor("multi@test.com"));
    assert.equal(p.createdAt, "2026-05-05T05:05:05.005Z");
  });
});
