import type { Currency } from "@mini-payments/shared";
import type { Queryable } from "./db.js";

export type LedgerMismatch = {
  orgId: string;
  currency: Currency;
  /** balances.available + balances.reserved */
  book: number;
  /** SUM(transactions.amount) over successful entries */
  ledger: number;
};

/**
 * The ledger invariant, per (org, currency):
 *   balances.available + balances.reserved = SUM(amount) of successful transactions
 * (pay-ins positive, paid pay-outs negative). Returns every pair where it doesn't hold,
 * including a currency that has entries but no balance row, or the reverse.
 * Mixing currencies in one sum would be meaningless, so it never does.
 */
export async function ledgerMismatches(db: Queryable, orgId?: string): Promise<LedgerMismatch[]> {
  const { rows } = await db.query<{ org_id: string; currency: Currency; book: string; ledger: string }>(
    `WITH book AS (
       SELECT org_id, currency, available + reserved AS amount FROM balances
     ), ledger AS (
       SELECT org_id, currency, SUM(amount) AS amount FROM transactions WHERE status = 'success' GROUP BY org_id, currency
     )
     SELECT COALESCE(b.org_id, l.org_id) AS org_id, COALESCE(b.currency, l.currency) AS currency,
            COALESCE(b.amount, 0)::text AS book, COALESCE(l.amount, 0)::text AS ledger
     FROM book b FULL JOIN ledger l ON l.org_id = b.org_id AND l.currency = b.currency
     WHERE COALESCE(b.amount, 0) <> COALESCE(l.amount, 0)
       AND ($1::text IS NULL OR COALESCE(b.org_id, l.org_id) = $1)
     ORDER BY 1, 2`,
    [orgId ?? null],
  );
  // Sums can exceed BIGINT's parser, so they come back as text and are checked here.
  const toNumber = (v: string) => {
    const n = Number(v);
    if (!Number.isSafeInteger(n)) throw new RangeError(`ledger sum ${v} is outside the safe integer range`);
    return n;
  };
  return rows.map((r) => ({ orgId: r.org_id, currency: r.currency, book: toNumber(r.book), ledger: toNumber(r.ledger) }));
}
