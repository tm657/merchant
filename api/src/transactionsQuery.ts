import type { Currency, SortDir, SortKey, Status, Transaction, TransactionType } from "@mini-payments/shared";
import { decodeCursor, encodeCursor, type Sort } from "./cursor.js";
import type { Queryable } from "./db.js";

/** The transactions list's filters and sort, as the list route and the CSV export use them. */
export type TransactionFilters = {
  type?: TransactionType;
  status?: Status;
  currency?: Currency;
  from?: string; // YYYY-MM-DD, inclusive (UTC)
  to?: string; // YYYY-MM-DD, inclusive (UTC)
  q?: string;
  sort: SortKey;
  dir: SortDir;
};

/** A cursor the caller sent that can't be used. The code is the API's error code. */
export class CursorError extends Error {
  constructor(readonly code: "invalid_cursor" | "cursor_sort_mismatch") {
    super(code);
  }
}

// Whitelist: the only strings ever interpolated into SQL.
const SORT_COLUMN: Record<Sort, "created_at" | "amount"> = {
  createdAt: "created_at",
  amount: "amount",
};

type Row = {
  id: string;
  type: TransactionType;
  merchant: string;
  amount: number;
  currency: Currency;
  status: Status;
  created_at: string;
  payout_id: string | null;
};

const nextDay = (date: string) => new Date(Date.parse(`${date}T00:00:00.000Z`) + 86_400_000).toISOString();

const escapeLike = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

/** WHERE clauses for an org and its filters. `arg` adds a bind parameter and returns its placeholder. */
function filterClauses(orgId: string, f: TransactionFilters, arg: (v: string | number) => string): string[] {
  const where: string[] = [`org_id = ${arg(orgId)}`];
  if (f.type) where.push(`type = ${arg(f.type)}`);
  if (f.status) where.push(`status = ${arg(f.status)}`);
  if (f.currency) where.push(`currency = ${arg(f.currency)}`);
  if (f.from) where.push(`created_at >= ${arg(`${f.from}T00:00:00.000Z`)}::timestamptz`);
  if (f.to) where.push(`created_at < ${arg(nextDay(f.to))}::timestamptz`);
  // ILIKE: case-insensitive, like SQLite's LIKE was for ASCII.
  if (f.q) where.push(`merchant ILIKE ${arg(`%${escapeLike(f.q)}%`)} ESCAPE '\\'`);
  return where;
}

/**
 * One keyset page, newest-first or by amount, exactly as the Transactions page shows it.
 * Throws CursorError for a malformed cursor or one made for another sort.
 */
export async function queryTransactionsPage(
  q: Queryable,
  orgId: string,
  f: TransactionFilters,
  rawCursor: string | undefined,
  limit: number,
): Promise<{ items: Transaction[]; nextCursor: string | null }> {
  const col = SORT_COLUMN[f.sort];
  const args: (string | number)[] = [];
  const arg = (value: string | number) => `$${args.push(value)}`;
  const where = filterClauses(orgId, f, arg);

  if (rawCursor) {
    const cursor = decodeCursor(rawCursor);
    if (!cursor) throw new CursorError("invalid_cursor");
    if (cursor.s !== f.sort || cursor.d !== f.dir) throw new CursorError("cursor_sort_mismatch");
    const cast = f.sort === "createdAt" ? "timestamptz" : "bigint";
    // Row comparison on (sort column, id); ids are COLLATE "C", so ties break by byte order.
    where.push(`(${col}, id) ${f.dir === "asc" ? ">" : "<"} (${arg(cursor.v)}::${cast}, ${arg(cursor.id)})`);
  }

  const sqlDir = f.dir === "asc" ? "ASC" : "DESC";
  const { rows } = await q.query<Row>(
    `SELECT id, type, merchant, amount, currency, status, created_at, payout_id
     FROM transactions
     WHERE ${where.join(" AND ")}
     ORDER BY ${col} ${sqlDir}, id ${sqlDir}
     LIMIT ${arg(limit + 1)}`,
    args,
  );

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const last = page.at(-1);
  const nextCursor =
    hasMore && last
      ? encodeCursor(
          f.sort === "createdAt"
            ? { s: "createdAt", d: f.dir, v: last.created_at, id: last.id }
            : { s: "amount", d: f.dir, v: last.amount, id: last.id },
        )
      : null;

  return {
    items: page.map((r) => ({
      id: r.id,
      type: r.type,
      merchant: r.merchant,
      amount: r.amount,
      currency: r.currency,
      status: r.status,
      createdAt: r.created_at,
      payoutId: r.payout_id,
    })),
    nextCursor,
  };
}

/** How many rows the filters match (for export progress and the row cap). */
export async function countTransactions(q: Queryable, orgId: string, f: TransactionFilters): Promise<number> {
  const args: (string | number)[] = [];
  const where = filterClauses(orgId, f, (v) => `$${args.push(v)}`);
  const { rows } = await q.query<{ n: number }>(`SELECT count(*) AS n FROM transactions WHERE ${where.join(" AND ")}`, args);
  return rows[0]!.n;
}
