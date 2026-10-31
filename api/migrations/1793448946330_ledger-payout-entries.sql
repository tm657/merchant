-- Up Migration

-- transactions is the org's ledger: pay-ins (amount >= 0) and paid pay-outs (amount < 0).
-- Invariant, per (org, currency): balances.available + balances.reserved
--   = SUM(transactions.amount) over status = 'success'.
-- A paid pay-out releases its reservation and books its negative entry in one transaction.

ALTER TABLE transactions
  ADD COLUMN type TEXT NOT NULL DEFAULT 'payin' CHECK (type IN ('payin', 'payout')),
  -- One ledger entry per pay-out at most: the unique index makes double-booking impossible.
  ADD COLUMN payout_id TEXT COLLATE "C" UNIQUE REFERENCES payouts (id);

ALTER TABLE transactions DROP CONSTRAINT transactions_amount_check;
ALTER TABLE transactions
  ADD CONSTRAINT transactions_amount_check CHECK (
    (type = 'payin' AND amount >= 0)
    OR (type = 'payout' AND amount < 0 AND status = 'success')
  ),
  ADD CONSTRAINT transactions_payout_link CHECK ((type = 'payout') = (payout_id IS NOT NULL));

-- Pay-out entries also tell open Transactions pages that a new row exists.
ALTER TABLE outbox DROP CONSTRAINT outbox_type_check;
ALTER TABLE outbox ADD CONSTRAINT outbox_type_check CHECK (type IN ('payout', 'balance', 'webhook', 'transactions'));

-- Backfill: pay-outs paid before this migration got no ledger entry. Book each one, dated
-- when it was paid (its timeline event; updated_at if that's missing).
INSERT INTO transactions (id, org_id, merchant, amount, currency, status, created_at, type, payout_id)
SELECT 'txn_' || p.id, p.org_id, p.beneficiary_name, -p.amount, p.currency, 'success',
       COALESCE((SELECT max(e.created_at) FROM payout_events e WHERE e.payout_id = p.id AND e.to_status = 'paid'), p.updated_at),
       'payout', p.id
FROM payouts p
WHERE p.status = 'paid'
  AND NOT EXISTS (SELECT 1 FROM transactions t WHERE t.payout_id = p.id);

-- Down Migration

DELETE FROM outbox WHERE type = 'transactions';
ALTER TABLE outbox DROP CONSTRAINT outbox_type_check;
ALTER TABLE outbox ADD CONSTRAINT outbox_type_check CHECK (type IN ('payout', 'balance', 'webhook'));
DELETE FROM transactions WHERE type = 'payout';
ALTER TABLE transactions DROP CONSTRAINT transactions_payout_link;
ALTER TABLE transactions DROP CONSTRAINT transactions_amount_check;
ALTER TABLE transactions ADD CONSTRAINT transactions_amount_check CHECK (amount >= 0);
ALTER TABLE transactions DROP COLUMN payout_id, DROP COLUMN type;
