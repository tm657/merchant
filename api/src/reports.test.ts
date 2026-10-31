import { formatMinorUnits, type ExportJob, type SettlementsResponse } from "@mini-payments/shared";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "vitest";
import { csvAmount, csvText } from "./csv.js";
import { withTransaction } from "./db.js";
import type { OrgEvent } from "./events.js";
import { createExportWorker, transactionCsvLine } from "./exports/worker.js";
import { listSettlements, settle } from "./settlements.js";
import { fakeClock, makeTestApp, TEST_EXPORT_DIR } from "./test/helpers.js";

type T = Awaited<ReturnType<typeof makeTestApp>>;
const log = { info() {}, warn() {}, error() {} } as never;

async function addTx(t: T, rows: { id: string; amount: number; currency?: string; status?: string; type?: string; at: string; merchant?: string; org?: string }[]) {
  for (const r of rows) {
    await t.db.query(
      `INSERT INTO transactions (id, org_id, merchant, amount, currency, status, created_at, type, payout_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'payin', NULL)`,
      [r.id, r.org ?? "org_1", r.merchant ?? "Shop", r.amount, r.currency ?? "USD", r.status ?? "success", r.at],
    );
  }
}

const worker = (t: T, opts: Partial<Parameters<typeof createExportWorker>[0]> = {}) =>
  createExportWorker({ db: t.db, redis: t.redis, prefix: t.redisPrefix, exportDir: TEST_EXPORT_DIR, log, clock: t.clock.now, ...opts });

async function requestExport(t: T, token: string, filters: object = {}) {
  return t.app.inject({ method: "POST", url: "/orgs/org_1/exports", headers: { authorization: `Bearer ${token}` }, payload: filters });
}

async function jobRow(t: T, id: string) {
  const { rows } = await t.db.query<{ status: string; rows_written: number; rows_total: number | null; file_name: string | null; error: string | null; attempts: number }>(
    "SELECT status, rows_written, rows_total, file_name, error, attempts FROM export_jobs WHERE id = $1",
    [id],
  );
  return rows[0]!;
}

describe("money and CSV cells", () => {
  it("formats minor units as decimal strings by exponent, without floats", () => {
    assert.equal(formatMinorUnits(-3333, "USD"), "-33.33");
    assert.equal(formatMinorUnits(5, "USD"), "0.05");
    assert.equal(formatMinorUnits(-5, "PHP"), "-0.05");
    assert.equal(formatMinorUnits(0, "USD"), "0.00");
    assert.equal(formatMinorUnits(15_000, "IDR"), "15000");
    assert.equal(formatMinorUnits(Number.MAX_SAFE_INTEGER, "USD"), "90071992547409.91");
    assert.throws(() => formatMinorUnits(1.5, "USD"));
  });

  it("prefixes every text cell that could run as a formula, but not our formatted amounts", () => {
    for (const s of ["=SUM(A1)", "+1", "-12.34", "@cmd", "\tx", "\rx"]) assert.ok(csvText(s).replace(/^"/, "").startsWith("'"), JSON.stringify(s));
    assert.equal(csvText("Acme, Inc"), '"Acme, Inc"');
    assert.equal(csvText('say "hi"'), '"say ""hi"""');
    assert.equal(csvText(null), "");
    assert.equal(csvAmount("-12.34"), "-12.34");
    assert.throws(() => csvAmount("=1+1"));
  });

  it("writes a counterparty named -12.34 as text (prefixed) while the amount stays a number", () => {
    const line = transactionCsvLine({
      id: "txn_1",
      type: "payout",
      merchant: "-12.34",
      amount: -1234,
      currency: "USD",
      status: "success",
      createdAt: "2026-01-02T03:04:05.006Z",
      payoutId: "po_1",
    });
    assert.equal(line, "txn_1,2026-01-02T03:04:05.006Z,payout,success,'-12.34,-12.34,USD,po_1\r\n");
  });
});

describe("exports", () => {
  it("needs reports:export: admin and finance yes, support no", async () => {
    const t = await makeTestApp();
    assert.equal((await requestExport(t, await t.tokenFor("support@test.com"))).statusCode, 403);
    assert.equal((await requestExport(t, await t.tokenFor("multi@test.com"))).statusCode, 202);
    assert.equal((await requestExport(t, await t.tokenFor("admin@test.com"))).statusCode, 202);
    assert.equal((await requestExport(t, await t.tokenFor("admin@test.com"), { sort: "nope" })).statusCode, 400);
  });

  it("streams the filtered list into a CSV, in list order, with progress and a final event", async () => {
    const t = await makeTestApp(fakeClock(Date.now()));
    await addTx(t, [
      { id: "txn_a", amount: 1999, at: "2026-03-01T10:00:00.000Z", merchant: "=cmd|' /C calc'!A0" },
      { id: "txn_b", amount: 150_000, currency: "IDR", at: "2026-03-02T10:00:00.000Z" },
      { id: "txn_c", amount: 5, at: "2026-03-03T10:00:00.000Z", status: "failed" },
    ]);
    const admin = await t.tokenFor("admin@test.com");
    const events: OrgEvent[] = [];
    const unsubscribe = await t.bus.subscribe("org_1", (e) => events.push(e));

    const res = await requestExport(t, admin, { status: "success", sort: "createdAt", dir: "asc" });
    const job = (res.json() as { export: ExportJob }).export;
    assert.equal(job.status, "queued");
    const audited = await t.db.query("SELECT 1 FROM audit_log WHERE action = 'report.export.requested' AND target_id = $1", [job.id]);
    assert.equal(audited.rowCount, 1);

    assert.equal(await worker(t, { pageSize: 1 }).runOnce(2), 1);
    const row = await jobRow(t, job.id);
    assert.deepEqual([row.status, row.rows_written, row.rows_total], ["completed", 2, 2]);
    const csv = readFileSync(join(TEST_EXPORT_DIR, row.file_name!), "utf8");
    assert.equal(
      csv,
      "id,created_at,type,status,counterparty,amount,currency,payout_id\r\n" +
        "txn_a,2026-03-01T10:00:00.000Z,payin,success,'=cmd|' /C calc'!A0,19.99,USD,\r\n" +
        "txn_b,2026-03-02T10:00:00.000Z,payin,success,Shop,150000,IDR,\r\n",
    );

    const { publishOutboxBatch } = await import("./outbox.js");
    await publishOutboxBatch(t.db, t.redis, { prefix: t.redisPrefix });
    await new Promise((r) => setTimeout(r, 150));
    unsubscribe();
    const exportEvents = events.filter((e): e is Extract<OrgEvent, { type: "export" }> => e.type === "export");
    assert.ok(exportEvents.some((e) => e.status === "running" && e.rowsWritten === 1), "progress after the first page");
    assert.deepEqual(exportEvents.at(-1), { type: "export", exportId: job.id, status: "completed", rowsWritten: 2, rowsTotal: 2 });
  });

  it("fails over the row cap or the size cap, deleting the partial file", async () => {
    const t = await makeTestApp();
    await addTx(t, Array.from({ length: 5 }, (_, i) => ({ id: `txn_${i}`, amount: 100 + i, at: `2026-03-0${i + 1}T10:00:00.000Z`, merchant: "x".repeat(200) })));
    const admin = await t.tokenFor("admin@test.com");
    const tooMany = (await requestExport(t, admin)).json() as { export: ExportJob };
    await worker(t, { maxRows: 4 }).runOnce(2);
    const a = await jobRow(t, tooMany.export.id);
    assert.equal(a.status, "failed");
    assert.match(a.error!, /too many rows: 5 match, the limit is 4/);

    const tooBig = (await requestExport(t, admin)).json() as { export: ExportJob };
    await worker(t, { maxBytes: 1024, pageSize: 2 }).runOnce(2);
    const b = await jobRow(t, tooBig.export.id);
    assert.equal(b.status, "failed");
    assert.match(b.error!, /file too large/);
    assert.equal(b.file_name, null);
  });

  it("runs at most two exports per org at once, even with racing workers", async () => {
    const t = await makeTestApp();
    const admin = await t.tokenFor("admin@test.com");
    const ids: string[] = [];
    for (let i = 0; i < 4; i++) ids.push(((await requestExport(t, admin)).json() as { export: ExportJob }).export.id);
    const [w1, w2] = [worker(t), worker(t)];
    const [c1, c2] = await Promise.all([w1.claim(4), w2.claim(4)]);
    const claimed = [...c1, ...c2].map((c) => c.id);
    assert.equal(claimed.length, 2, "only two slots for org_1");
    assert.equal(new Set(claimed).size, 2, "never the same job twice");
    assert.equal(await w1.slots.running("org_1"), 2);
    const { rows } = await t.db.query<{ n: number }>("SELECT count(*) AS n FROM export_jobs WHERE status = 'queued'");
    assert.equal(rows[0]!.n, 2, "the rest wait");

    // Finishing one frees its slot for the next.
    await w1.run([...c1, ...c2][0]!);
    assert.equal(await w1.slots.running("org_1"), 1);
    assert.equal((await w2.claim(4)).length, 1);
  });

  it("reclaims an export whose worker crashed, after its lease", async () => {
    const t = await makeTestApp();
    const admin = await t.tokenFor("admin@test.com");
    const job = ((await requestExport(t, admin)).json() as { export: ExportJob }).export;
    const crashed = worker(t, { leaseMs: 60_000 });
    assert.equal((await crashed.claim(1)).length, 1);
    assert.equal((await worker(t).claim(1)).length, 0, "still leased");
    t.clock.advance(60_001);
    const healthy = worker(t);
    const [again] = await healthy.claim(1);
    assert.equal(again?.id, job.id);
    assert.equal(again?.attempts, 2);
    assert.equal(await healthy.run(again!), "completed");
  });

  it("caps queued exports per org with 429", async () => {
    const t = await makeTestApp();
    const admin = await t.tokenFor("admin@test.com");
    for (let i = 0; i < 20; i++) assert.equal((await requestExport(t, admin)).statusCode, 202);
    const res = await requestExport(t, admin);
    assert.equal(res.statusCode, 429);
    assert.deepEqual(res.json(), { error: "too_many_exports" });
  });
});

describe("export downloads", () => {
  async function completedExport(t: T) {
    await addTx(t, [{ id: "txn_d", amount: 4200, at: "2026-04-01T00:00:00.000Z" }]);
    const job = ((await requestExport(t, await t.tokenFor("multi@test.com"))).json() as { export: ExportJob }).export;
    await worker(t).runOnce(2);
    return job;
  }

  it("is authorised on every request, sends Content-Disposition, and is audited", async () => {
    const t = await makeTestApp(fakeClock(Date.now()));
    const job = await completedExport(t);
    const url = `/orgs/org_1/exports/${job.id}/download`;
    const res = await t.get(url, await t.tokenFor("admin@test.com"));
    assert.equal(res.statusCode, 200, res.body);
    assert.match(String(res.headers["content-disposition"]), /^attachment; filename="transactions-org_1-\d{4}-\d{2}-\d{2}-[a-z0-9-]{8}\.csv"$/);
    assert.match(String(res.headers["content-type"]), /text\/csv/);
    assert.equal(res.headers["cache-control"], "private, no-store");
    assert.match(res.body, /txn_d,.*,42\.00,USD/);
    assert.equal(res.headers["content-length"], String(Buffer.byteLength(res.body)));

    assert.equal((await t.get(url)).statusCode, 401);
    assert.equal((await t.get(url, await t.tokenFor("support@test.com"))).statusCode, 403);
    // multi is admin of org_2, but this export belongs to org_1.
    assert.equal((await t.get(`/orgs/org_2/exports/${job.id}/download`, await t.tokenFor("multi@test.com"))).statusCode, 404);
    const audited = await t.db.query("SELECT 1 FROM audit_log WHERE action = 'report.export.downloaded' AND target_id = $1", [job.id]);
    assert.equal(audited.rowCount, 1);
  });

  it("answers 409 before it's ready and 410 after 24 hours; cleanup deletes the file", async () => {
    const t = await makeTestApp(fakeClock(Date.now()));
    const admin = await t.tokenFor("admin@test.com");
    const queued = ((await requestExport(t, admin)).json() as { export: ExportJob }).export;
    assert.deepEqual((await t.get(`/orgs/org_1/exports/${queued.id}/download`, admin)).json(), { error: "export_not_ready" });

    const job = await completedExport(t);
    const file = join(TEST_EXPORT_DIR, (await jobRow(t, job.id)).file_name!);
    assert.ok(existsSync(file));
    t.clock.advance(24 * 60 * 60 * 1000 + 1);
    const admin2 = await t.tokenFor("admin@test.com");
    assert.equal((await t.get(`/orgs/org_1/exports/${job.id}/download`, admin2)).statusCode, 410);
    const { expired } = await worker(t).cleanup();
    assert.ok(expired >= 1);
    assert.equal(existsSync(file), false);
    assert.equal((await jobRow(t, job.id)).status, "expired");
    const list = (await t.get("/orgs/org_1/exports", admin2)).json() as { items: ExportJob[] };
    assert.equal(list.items.find((j) => j.id === job.id)?.downloadable, false);
  });
});

describe("settlements", () => {
  it("reconcile: settlement totals equal transaction totals for a period", async () => {
    const t = await makeTestApp();
    await addTx(t, [
      { id: "s1", amount: 1000, at: "2026-05-01T00:00:00.000Z" }, // first ms of the day
      { id: "s2", amount: 250, at: "2026-05-01T23:59:59.999Z" }, // last ms of the day
      { id: "s3", amount: 7, at: "2026-05-02T00:00:00.000Z" }, // next day
      { id: "s4", amount: 99, at: "2026-05-01T12:00:00.000Z", status: "pending" }, // not settled
      { id: "s5", amount: 98, at: "2026-05-01T12:00:00.000Z", status: "failed" }, // not settled
      { id: "s6", amount: 15_000, currency: "IDR", at: "2026-05-02T08:00:00.000Z" },
      { id: "s7", amount: 500, at: "2026-04-30T23:59:59.999Z" }, // before the period
      { id: "s8", amount: 300, at: "2026-05-01T09:00:00.000Z", org: "org_2" }, // other org
    ]);
    // A paid pay-out entry (negative) inside the period.
    await t.owner.query(
      `INSERT INTO payouts (id, org_id, amount, currency, beneficiary_name, account_number, status, version, created_by, decided_by, created_at, updated_at)
       VALUES ('po_s', 'org_1', 400, 'USD', 'Payee', 'GB1234', 'paid', 4, 'u_multi', 'u_admin', now(), now())`,
    );
    await t.db.query(
      `INSERT INTO transactions (id, org_id, merchant, amount, currency, status, created_at, type, payout_id)
       VALUES ('s9', 'org_1', 'Payee', -400, 'USD', 'success', '2026-05-02T15:00:00.000Z', 'payout', 'po_s')`,
    );

    assert.deepEqual(await settle(t.db, { from: "2026-04-25", to: "2026-05-05" }), { status: "done", from: "2026-04-25", to: "2026-05-05", rows: 5 });
    const period = { from: "2026-05-01", to: "2026-05-02" };
    const admin = await t.tokenFor("admin@test.com");
    const res = (await t.get(`/orgs/org_1/settlements?from=${period.from}&to=${period.to}`, admin)).json() as SettlementsResponse;

    // The same totals straight from the ledger, for the same UTC period.
    const { rows } = await t.db.query<{ currency: string; payin: string; payout: string; net: string; payins: string; payouts: string }>(
      `SELECT currency,
              COALESCE(sum(amount) FILTER (WHERE type = 'payin'), 0)::text AS payin,
              COALESCE(sum(amount) FILTER (WHERE type = 'payout'), 0)::text AS payout,
              sum(amount)::text AS net,
              count(*) FILTER (WHERE type = 'payin')::text AS payins,
              count(*) FILTER (WHERE type = 'payout')::text AS payouts
       FROM transactions
       WHERE org_id = 'org_1' AND status = 'success'
         AND created_at >= '2026-05-01T00:00:00Z' AND created_at < '2026-05-03T00:00:00Z'
       GROUP BY currency ORDER BY currency COLLATE "C"`,
    );
    assert.deepEqual(
      res.totals.map((x) => [x.currency, x.payinAmount, x.payoutAmount, x.netAmount, x.payinCount, x.payoutCount]),
      rows.map((r) => [r.currency, Number(r.payin), Number(r.payout), Number(r.net), Number(r.payins), Number(r.payouts)]),
    );
    assert.deepEqual(
      res.totals.map((x) => [x.currency, x.netAmount]),
      [["IDR", 15_000], ["USD", 1000 + 250 + 7 - 400]],
    );
    assert.deepEqual(
      res.items.map((s) => [s.date, s.currency, s.payinAmount, s.payoutAmount, s.netAmount]),
      [
        ["2026-05-02", "IDR", 15_000, 0, 15_000],
        ["2026-05-02", "USD", 7, -400, -393],
        ["2026-05-01", "USD", 1250, 0, 1250],
      ],
    );
    assert.equal((await t.get(`/orgs/org_1/settlements?from=${period.from}&to=${period.to}`, await t.tokenFor("support@test.com"))).statusCode, 403);
  });

  it("is idempotent and picks up late entries when re-run", async () => {
    const t = await makeTestApp();
    await addTx(t, [{ id: "l1", amount: 100, at: "2026-06-10T10:00:00.000Z" }]);
    await settle(t.db, { from: "2026-06-10", to: "2026-06-10" });
    await settle(t.db, { from: "2026-06-10", to: "2026-06-10" });
    await addTx(t, [{ id: "l2", amount: 23, at: "2026-06-10T11:00:00.000Z" }]);
    await settle(t.db, { from: "2026-06-10", to: "2026-06-10" });
    const res = await listSettlements(t.db, "org_1", "2026-06-10", "2026-06-10");
    assert.deepEqual(res.items.map((s) => [s.payinCount, s.netAmount]), [[2, 123]]);
  });

  it("lets only one instance run at a time (advisory lock)", async () => {
    const t = await makeTestApp();
    await addTx(t, [{ id: "k1", amount: 100, at: "2026-07-01T10:00:00.000Z" }]);
    await withTransaction(t.db, async (other) => {
      // Another instance is mid-run: it holds the lock until its transaction ends.
      await other.query("SELECT pg_advisory_xact_lock(hashtext('mini-payments:settlements'))");
      assert.deepEqual(await settle(t.db, { from: "2026-07-01", to: "2026-07-01" }), { status: "skipped" });
    });
    assert.equal((await settle(t.db, { from: "2026-07-01", to: "2026-07-01" })).status, "done");
  });
});
