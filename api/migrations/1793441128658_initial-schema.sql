-- Up Migration

-- The app schema, ported from the original SQLite schema with the same tables, CHECKs
-- and indexes.
--
-- * Money columns are BIGINT minor units (IDR balances overflow INTEGER). The API parses
--   BIGINT into a JS number and refuses values past Number.MAX_SAFE_INTEGER.
-- * Timestamps are TIMESTAMPTZ(3): millisecond precision, the same as JS Date. Cursors
--   carry a timestamp as an ISO string, so it must round-trip exactly.
-- * Every id column uses COLLATE "C" (byte order, as SQLite did). ids are the tie-breaker
--   in keyset pagination, so their order must not depend on the server's locale.
-- * The currency, status and role lists must match @mini-payments/shared.

CREATE TABLE orgs (
  id   TEXT COLLATE "C" PRIMARY KEY,
  name TEXT NOT NULL
);

CREATE TABLE transactions (
  id         TEXT COLLATE "C" PRIMARY KEY,
  org_id     TEXT COLLATE "C" NOT NULL REFERENCES orgs (id),
  merchant   TEXT NOT NULL,
  amount     BIGINT NOT NULL CHECK (amount >= 0),
  currency   TEXT NOT NULL CHECK (currency IN ('USD', 'IDR', 'PHP')),
  status     TEXT NOT NULL CHECK (status IN ('pending', 'success', 'failed')),
  created_at TIMESTAMPTZ(3) NOT NULL
);

-- Keyset pagination: (org, sort column, id) for each sort.
CREATE INDEX idx_tx_org_created ON transactions (org_id, created_at, id);
CREATE INDEX idx_tx_org_amount  ON transactions (org_id, amount, id);

CREATE TABLE balances (
  org_id     TEXT COLLATE "C" NOT NULL REFERENCES orgs (id),
  currency   TEXT NOT NULL CHECK (currency IN ('USD', 'IDR', 'PHP')),
  available  BIGINT NOT NULL,
  updated_at TIMESTAMPTZ(3) NOT NULL,
  PRIMARY KEY (org_id, currency)
);

CREATE TABLE users (
  id            TEXT COLLATE "C" PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE CHECK (email = lower(email)),
  name          TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  created_at    TIMESTAMPTZ(3) NOT NULL
);

CREATE TABLE memberships (
  user_id TEXT COLLATE "C" NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  org_id  TEXT COLLATE "C" NOT NULL REFERENCES orgs (id) ON DELETE CASCADE,
  role    TEXT NOT NULL CHECK (role IN ('admin', 'finance', 'support')),
  PRIMARY KEY (user_id, org_id)
);

-- Only the SHA-256 of a session token is stored, never the token itself.
CREATE TABLE sessions (
  id           TEXT COLLATE "C" PRIMARY KEY,
  user_id      TEXT COLLATE "C" NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  token_hash   TEXT NOT NULL UNIQUE,
  created_at   TIMESTAMPTZ(3) NOT NULL,
  last_seen_at TIMESTAMPTZ(3) NOT NULL,
  expires_at   TIMESTAMPTZ(3) NOT NULL,
  user_agent   TEXT
);
CREATE INDEX idx_sessions_user ON sessions (user_id);

-- Down Migration

DROP TABLE sessions;
DROP TABLE memberships;
DROP TABLE users;
DROP TABLE balances;
DROP TABLE transactions;
DROP TABLE orgs;
