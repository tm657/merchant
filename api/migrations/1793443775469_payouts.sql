-- Up Migration

-- Pay-outs: approval flow, worker processing, idempotent creation and an outbox.
-- Statuses must match PAYOUT_STATUSES in @mini-payments/shared.

-- Funds held for approved pay-outs move from available to reserved, so neither may go negative.
ALTER TABLE balances
  ADD COLUMN reserved BIGINT NOT NULL DEFAULT 0 CHECK (reserved >= 0),
  ADD CONSTRAINT balances_available_check CHECK (available >= 0);

CREATE TABLE payouts (
  id               TEXT COLLATE "C" PRIMARY KEY,
  org_id           TEXT COLLATE "C" NOT NULL REFERENCES orgs (id),
  amount           BIGINT NOT NULL CHECK (amount > 0),
  currency         TEXT NOT NULL CHECK (currency IN ('USD', 'IDR', 'PHP')),
  beneficiary_name TEXT NOT NULL,
  account_number   TEXT NOT NULL,
  reference        TEXT NOT NULL DEFAULT '',
  status           TEXT NOT NULL CHECK (status IN
                     ('pending_approval', 'approved', 'processing', 'paid', 'failed', 'rejected', 'cancelled')),
  -- Optimistic concurrency: bumped on every state change; writers send the version they read.
  version          INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_by       TEXT COLLATE "C" NOT NULL REFERENCES users (id),
  decided_by       TEXT COLLATE "C" REFERENCES users (id),
  decided_at       TIMESTAMPTZ(3),
  reject_reason    TEXT,
  failure_reason   TEXT,
  -- Worker bookkeeping. attempts doubles as a fencing token for a claimed row.
  attempts         INTEGER NOT NULL DEFAULT 0,
  next_attempt_at  TIMESTAMPTZ(3),
  lease_expires_at TIMESTAMPTZ(3),
  provider_ref     TEXT,
  created_at       TIMESTAMPTZ(3) NOT NULL,
  updated_at       TIMESTAMPTZ(3) NOT NULL,
  -- Four-eyes rule, enforced by the database itself: nobody decides their own pay-out.
  CONSTRAINT payouts_not_self_decided CHECK (decided_by IS NULL OR decided_by <> created_by),
  CONSTRAINT payouts_reject_reason CHECK (status <> 'rejected' OR reject_reason IS NOT NULL)
);

-- List: newest first, optionally by status.
CREATE INDEX idx_payouts_org_created ON payouts (org_id, created_at, id);
CREATE INDEX idx_payouts_org_status_created ON payouts (org_id, status, created_at, id);
-- Worker: only rows it could claim.
CREATE INDEX idx_payouts_claimable ON payouts (next_attempt_at, id) WHERE status IN ('approved', 'processing');

-- History for the timeline. from_status = to_status records a retry inside processing.
CREATE TABLE payout_events (
  id          BIGSERIAL PRIMARY KEY,
  payout_id   TEXT COLLATE "C" NOT NULL REFERENCES payouts (id),
  from_status TEXT,
  to_status   TEXT NOT NULL,
  actor_id    TEXT COLLATE "C" REFERENCES users (id), -- NULL: the system (worker)
  reason      TEXT,
  created_at  TIMESTAMPTZ(3) NOT NULL
);
CREATE INDEX idx_payout_events_payout ON payout_events (payout_id, id);

-- One row per (org, key). The stored response is replayed for a repeat with the same body.
CREATE TABLE idempotency_keys (
  org_id          TEXT COLLATE "C" NOT NULL REFERENCES orgs (id),
  key             TEXT COLLATE "C" NOT NULL,
  request_hash    TEXT NOT NULL,
  response_status INTEGER,
  response_body   JSONB,
  created_at      TIMESTAMPTZ(3) NOT NULL,
  PRIMARY KEY (org_id, key)
);
CREATE INDEX idx_idempotency_keys_created ON idempotency_keys (created_at);

-- Events committed with the state change that caused them; the publisher sends them to Redis.
CREATE TABLE outbox (
  id           BIGSERIAL PRIMARY KEY,
  org_id       TEXT COLLATE "C" NOT NULL REFERENCES orgs (id),
  type         TEXT NOT NULL CHECK (type IN ('payout', 'balance')),
  payload      JSONB NOT NULL,
  created_at   TIMESTAMPTZ(3) NOT NULL,
  published_at TIMESTAMPTZ(3)
);
CREATE INDEX idx_outbox_unpublished ON outbox (id) WHERE published_at IS NULL;
CREATE INDEX idx_outbox_published ON outbox (published_at) WHERE published_at IS NOT NULL;

-- Down Migration

DROP TABLE outbox;
DROP TABLE idempotency_keys;
DROP TABLE payout_events;
DROP TABLE payouts;
ALTER TABLE balances DROP CONSTRAINT balances_available_check, DROP COLUMN reserved;
