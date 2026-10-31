-- Up Migration

-- CSV export jobs. The worker claims queued rows with FOR UPDATE SKIP LOCKED; at most two
-- run per org at once (a Redis slot set); files live under EXPORT_DIR for 24 hours.
CREATE TABLE export_jobs (
  id               TEXT COLLATE "C" PRIMARY KEY,
  org_id           TEXT COLLATE "C" NOT NULL REFERENCES orgs (id),
  requested_by     TEXT COLLATE "C" NOT NULL REFERENCES users (id),
  filters          JSONB NOT NULL,
  status           TEXT NOT NULL CHECK (status IN ('queued', 'running', 'completed', 'failed', 'expired')),
  rows_total       INTEGER,
  rows_written     INTEGER NOT NULL DEFAULT 0,
  bytes_written    BIGINT NOT NULL DEFAULT 0,
  -- A random name under EXPORT_DIR; never derived from user input.
  file_name        TEXT CHECK (file_name ~ '^[A-Za-z0-9_-]+\.csv$'),
  error            TEXT,
  attempts         INTEGER NOT NULL DEFAULT 0, -- also the fencing token for a claim
  lease_expires_at TIMESTAMPTZ(3),
  created_at       TIMESTAMPTZ(3) NOT NULL,
  started_at       TIMESTAMPTZ(3),
  completed_at     TIMESTAMPTZ(3),
  expires_at       TIMESTAMPTZ(3),
  CONSTRAINT export_jobs_completed_file CHECK (status <> 'completed' OR (file_name IS NOT NULL AND expires_at IS NOT NULL))
);
CREATE INDEX idx_export_jobs_org ON export_jobs (org_id, created_at, id);
CREATE INDEX idx_export_jobs_claimable ON export_jobs (created_at, id) WHERE status IN ('queued', 'running');
CREATE INDEX idx_export_jobs_expiring ON export_jobs (expires_at) WHERE status IN ('completed', 'failed');

-- Daily totals of successful ledger entries per org, currency and UTC day. Recomputed by
-- settle() under an advisory lock; always equal to the transactions they summarise.
CREATE TABLE settlements (
  org_id        TEXT COLLATE "C" NOT NULL REFERENCES orgs (id),
  currency      TEXT NOT NULL CHECK (currency IN ('USD', 'IDR', 'PHP')),
  date          DATE NOT NULL,
  payin_count   INTEGER NOT NULL CHECK (payin_count >= 0),
  payin_amount  BIGINT NOT NULL CHECK (payin_amount >= 0),
  payout_count  INTEGER NOT NULL CHECK (payout_count >= 0),
  payout_amount BIGINT NOT NULL CHECK (payout_amount <= 0),
  net_amount    BIGINT NOT NULL,
  computed_at   TIMESTAMPTZ(3) NOT NULL,
  PRIMARY KEY (org_id, currency, date),
  CONSTRAINT settlements_net CHECK (net_amount = payin_amount + payout_amount)
);

-- Final export states travel through the outbox (progress ticks go straight to Redis).
ALTER TABLE outbox DROP CONSTRAINT outbox_type_check;
ALTER TABLE outbox ADD CONSTRAINT outbox_type_check CHECK (type IN ('payout', 'balance', 'webhook', 'transactions', 'export'));

-- Down Migration

DELETE FROM outbox WHERE type = 'export';
ALTER TABLE outbox DROP CONSTRAINT outbox_type_check;
ALTER TABLE outbox ADD CONSTRAINT outbox_type_check CHECK (type IN ('payout', 'balance', 'webhook', 'transactions'));
DROP TABLE settlements;
DROP TABLE export_jobs;
