import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { makeTestApp } from "../test/helpers.js";

type Item = { id: string; merchant: string; amount: number; currency: string; status: string; createdAt: string };
type Page = { items: Item[]; nextCursor: string | null };

// Byte order, which is what COLLATE "C" gives and what SQLite used.
const byteCompare = (a: string, b: string) => Buffer.compare(Buffer.from(a), Buffer.from(b));

/**
 * Lots of ties on both sort columns, and ids whose byte order differs from a locale
 * order (upper vs lower case, '-' vs '_'), so the tie-breaker is really exercised.
 */
async function appWithTransactions() {
  const t = await makeTestApp();
  const ids = ["TXN_d", "txn-c", "txn_B", "txn_a", "Txn_e", "txn_10", "txn_9", "txn__f", "txn.g", "txn~h"];
  const times = ["2026-03-01T10:00:00.000Z", "2026-03-01T10:00:00.000Z", "2026-03-02T10:00:00.123Z"];
  const rows: Item[] = [];
  let i = 0;
  for (const prefix of ids) {
    for (const time of times) {
      rows.push({
        id: `${prefix}${i}`,
        merchant: i % 4 === 0 ? "100% Pure_Co" : i % 4 === 1 ? "Grab" : "Gojek",
        amount: [500, 500, 1000, 0][i % 4]!,
        currency: ["USD", "IDR", "PHP"][i % 3]!,
        status: ["success", "pending", "failed"][i % 3]!,
        createdAt: time,
      });
      i++;
    }
  }
  for (const r of rows) {
    await t.db.query(
      `INSERT INTO transactions (id, org_id, merchant, amount, currency, status, created_at)
       VALUES ($1, 'org_1', $2, $3, $4, $5, $6)`,
      [r.id, r.merchant, r.amount, r.currency, r.status, r.createdAt],
    );
  }
  const token = await t.tokenFor("admin@test.com");
  return { t, rows, token };
}

async function crawl(t: Awaited<ReturnType<typeof makeTestApp>>, token: string, query: string): Promise<Item[]> {
  const items: Item[] = [];
  let cursor: string | null = null;
  for (let guard = 0; guard < 100; guard++) {
    const res = await t.get(`/orgs/org_1/transactions?${query}${cursor ? `&cursor=${cursor}` : ""}`, token);
    assert.equal(res.statusCode, 200, res.body);
    const page = res.json() as Page;
    items.push(...page.items);
    cursor = page.nextCursor;
    if (!cursor) return items;
  }
  throw new Error("pagination did not terminate");
}

describe("transactions keyset pagination", () => {
  for (const sort of ["createdAt", "amount"] as const) {
    for (const dir of ["asc", "desc"] as const) {
      it(`visits every row exactly once in (${sort}, id) ${dir} order, with ties`, async () => {
        const { t, rows, token } = await appWithTransactions();
        const got = await crawl(t, token, `sort=${sort}&dir=${dir}&limit=4`);
        const key = (r: Item) => (sort === "amount" ? r.amount : Date.parse(r.createdAt));
        const expected = [...rows].sort((a, b) => {
          const c = key(a) - key(b) || byteCompare(a.id, b.id);
          return dir === "asc" ? c : -c;
        });
        assert.deepEqual(got.map((r) => r.id), expected.map((r) => r.id));
      });
    }
  }

  it("returns amounts as integers and timestamps as millisecond ISO strings", async () => {
    const { t, token } = await appWithTransactions();
    const res = await t.get("/orgs/org_1/transactions?sort=createdAt&dir=desc&limit=1", token);
    const [item] = (res.json() as Page).items;
    assert.ok(Number.isInteger(item!.amount));
    assert.equal(item!.createdAt, "2026-03-02T10:00:00.123Z");
  });

  it("matches merchant case-insensitively and treats % and _ literally", async () => {
    const { t, rows, token } = await appWithTransactions();
    const grab = await crawl(t, token, "q=gRaB&limit=100");
    assert.equal(grab.length, rows.filter((r) => r.merchant === "Grab").length);
    assert.equal((await crawl(t, token, "q=100%25&limit=100")).length, rows.filter((r) => r.merchant.includes("100%")).length);
    assert.equal((await crawl(t, token, "q=e_C&limit=100")).length, rows.filter((r) => r.merchant.includes("e_C")).length);
    assert.equal((await crawl(t, token, "q=%25%25")).length, 0, "%% is not a wildcard");
  });

  it("filters by inclusive UTC date range", async () => {
    const { t, rows, token } = await appWithTransactions();
    const day1 = await crawl(t, token, "from=2026-03-01&to=2026-03-01&limit=100");
    assert.equal(day1.length, rows.filter((r) => r.createdAt.startsWith("2026-03-01")).length);
    const day2 = await crawl(t, token, "from=2026-03-02&limit=100");
    assert.equal(day2.length, rows.filter((r) => r.createdAt.startsWith("2026-03-02")).length);
  });

  it("rejects a malformed cursor and a cursor from another sort", async () => {
    const { t, token } = await appWithTransactions();
    assert.deepEqual((await t.get("/orgs/org_1/transactions?cursor=zzz", token)).json(), { error: "invalid_cursor" });
    const first = (await t.get("/orgs/org_1/transactions?sort=amount&dir=desc&limit=2", token)).json() as Page;
    const res = await t.get(`/orgs/org_1/transactions?sort=createdAt&dir=desc&cursor=${first.nextCursor}`, token);
    assert.equal(res.statusCode, 400);
    assert.deepEqual(res.json(), { error: "cursor_sort_mismatch" });
  });
});
