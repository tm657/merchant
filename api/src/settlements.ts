import type { Currency, Settlement, SettlementsResponse } from "@mini-payments/shared";
import type { Clock } from "./auth/sessions.js";
import { parseBigint, withTransaction, type Db, type Queryable } from "./db.js";

/** One lock for the whole server: only one instance computes settlements at a time. */
const LOCK = "hashtext('mini-payments:settlements')";
/** Days recomputed on every daily run, so late ledger entries are picked up. */
export const RESETTLE_DAYS = 7;

const DAY_MS = 86_400_000;
export const utcDate = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const addDays = (date: string, days: number) => utcDate(Date.parse(`${date}T00:00:00.000Z`) + days * DAY_MS);

export type SettleResult = { status: "done"; from: string; to: string; rows: number } | { status: "skipped" };

/**
 * Recomputes settlements for UTC days [from, to] from successful transactions, in one
 * transaction under a transaction-scoped advisory lock: if another instance holds it,
 * this returns "skipped" at once instead of waiting. Idempotent: rows are upserted, and
 * rows for days that no longer have entries are removed, so settlements always equal
 * the transactions they summarise. Only finished days should be passed (before today).
 */
export async function settle(db: Db, { from, to, clock = Date.now }: { from: string; to: string; clock?: Clock }): Promise<SettleResult> {
  return withTransaction(db, async (tx) => {
    const { rows: lock } = await tx.query<{ ok: boolean }>(`SELECT pg_try_advisory_xact_lock(${LOCK}) AS ok`);
    if (!lock[0]!.ok) return { status: "skipped" };
    const now = new Date(clock()).toISOString();
    const start = `${from}T00:00:00.000Z`;
    const end = `${addDays(to, 1)}T00:00:00.000Z`;
    const { rowCount } = await tx.query(
      `WITH day AS (
         SELECT org_id, currency, (created_at AT TIME ZONE 'UTC')::date AS date,
                count(*) FILTER (WHERE type = 'payin') AS payin_count,
                COALESCE(sum(amount) FILTER (WHERE type = 'payin'), 0) AS payin_amount,
                count(*) FILTER (WHERE type = 'payout') AS payout_count,
                COALESCE(sum(amount) FILTER (WHERE type = 'payout'), 0) AS payout_amount
         FROM transactions
         WHERE status = 'success' AND created_at >= $1::timestamptz AND created_at < $2::timestamptz
         GROUP BY 1, 2, 3
       ), removed AS (
         DELETE FROM settlements s
         WHERE s.date BETWEEN $3::date AND $4::date
           AND NOT EXISTS (SELECT 1 FROM day d WHERE d.org_id = s.org_id AND d.currency = s.currency AND d.date = s.date)
       )
       INSERT INTO settlements (org_id, currency, date, payin_count, payin_amount, payout_count, payout_amount, net_amount, computed_at)
       SELECT org_id, currency, date, payin_count, payin_amount, payout_count, payout_amount, payin_amount + payout_amount, $5
       FROM day
       ON CONFLICT (org_id, currency, date) DO UPDATE SET
         payin_count = excluded.payin_count, payin_amount = excluded.payin_amount,
         payout_count = excluded.payout_count, payout_amount = excluded.payout_amount,
         net_amount = excluded.net_amount, computed_at = excluded.computed_at`,
      [start, end, from, to, now],
    );
    return { status: "done", from, to, rows: rowCount ?? 0 };
  });
}

/**
 * The daily run's range: up to yesterday (UTC), starting RESETTLE_DAYS before the last
 * settled day, or at the first transaction if nothing is settled yet. Null when there's
 * nothing to do.
 */
export async function dailyWindow(q: Queryable, clock: Clock = Date.now): Promise<{ from: string; to: string } | null> {
  const to = utcDate(clock() - DAY_MS);
  const { rows } = await q.query<{ last: string | null; first: string | null }>(
    `SELECT (SELECT max(date)::text FROM settlements) AS last,
            (SELECT (min(created_at) AT TIME ZONE 'UTC')::date::text FROM transactions WHERE status = 'success') AS first`,
  );
  const { last, first } = rows[0]!;
  const from = last ? addDays(last, -RESETTLE_DAYS) : first;
  if (!from || from > to) return null;
  return { from, to };
}

type SettlementRow = {
  date: string;
  currency: Currency;
  payin_count: number;
  payin_amount: number;
  payout_count: number;
  payout_amount: number;
  net_amount: number;
  computed_at: string;
};

/** Settlements for an org over [from, to], newest day first, plus totals per currency. */
export async function listSettlements(q: Queryable, orgId: string, from: string, to: string): Promise<SettlementsResponse> {
  const { rows } = await q.query<SettlementRow>(
    `SELECT date, currency, payin_count, payin_amount, payout_count, payout_amount, net_amount, computed_at
     FROM settlements WHERE org_id = $1 AND date BETWEEN $2::date AND $3::date
     ORDER BY date DESC, currency COLLATE "C"`,
    [orgId, from, to],
  );
  const { rows: totals } = await q.query<{
    currency: Currency;
    payin_count: string;
    payin_amount: string;
    payout_count: string;
    payout_amount: string;
    net_amount: string;
  }>(
    `SELECT currency, sum(payin_count)::text AS payin_count, sum(payin_amount)::text AS payin_amount,
            sum(payout_count)::text AS payout_count, sum(payout_amount)::text AS payout_amount, sum(net_amount)::text AS net_amount
     FROM settlements WHERE org_id = $1 AND date BETWEEN $2::date AND $3::date
     GROUP BY currency ORDER BY currency COLLATE "C"`,
    [orgId, from, to],
  );
  const items: Settlement[] = rows.map((r) => ({
    date: r.date,
    currency: r.currency,
    payinCount: r.payin_count,
    payinAmount: r.payin_amount,
    payoutCount: r.payout_count,
    payoutAmount: r.payout_amount,
    netAmount: r.net_amount,
    computedAt: r.computed_at,
  }));
  return {
    from,
    to,
    items,
    // Sums of BIGINT come back as NUMERIC text; parseBigint refuses anything unsafe.
    totals: totals.map((t) => ({
      currency: t.currency,
      payinCount: parseBigint(t.payin_count),
      payinAmount: parseBigint(t.payin_amount),
      payoutCount: parseBigint(t.payout_count),
      payoutAmount: parseBigint(t.payout_amount),
      netAmount: parseBigint(t.net_amount),
    })),
  };
}
