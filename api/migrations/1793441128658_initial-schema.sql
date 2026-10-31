-- Up Migration

-- Postgres port of the SQLite schema in src/db.ts. Schema only: data is not copied yet.
-- Money columns are BIGINT minor units (IDR balances overflow INTEGER). The currency,
-- status and role lists must match @mini-payments/shared.

CREATE TABLE orgs (
  id   TEXT PRIMARY KEY,
  name TEXT NOT NULL
);

CREATE TABLE transactions (
  id         TEXT PRIMARY KEY,
  org_id     TEXT NOT NULL REFERENCES orgs (id),
  merchant   TEXT NOT NULL,
  amount     BIGINT NOT NULL CHECK (amount >= 0),
  currency   TEXT NOT NULL CHECK (currency IN ('USD', 'IDR', 'PHP')),
  status     TEXT NOT NULL CHECK (status IN ('pending', 'success', 'failed')),
  created_at TIMESTAMPTZ NOT NULL
);

-- Keyset pagination: (org, sort column, id) for each sort.
CREATE INDEX idx_tx_org_created ON transactions (org_id, created_at, id);
CREATE INDEX idx_tx_org_amount  ON transactions (org_id, amount, id);

CREATE TABLE balances (
  org_id     TEXT NOT NULL REFERENCES orgs (id),
  currency   TEXT NOT NULL CHECK (currency IN ('USD', 'IDR', 'PHP')),
  available  BIGINT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (org_id, currency)
);

CREATE TABLE users (
  id            TEXT PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE CHECK (email = lower(email)),
  name          TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL
);

CREATE TABLE memberships (
  user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  org_id  TEXT NOT NULL REFERENCES orgs (id) ON DELETE CASCADE,
  role    TEXT NOT NULL CHECK (role IN ('admin', 'finance', 'support')),
  PRIMARY KEY (user_id, org_id)
);
CREATE INDEX idx_memberships_org ON memberships (org_id);

-- Only the SHA-256 of a session token is stored, never the token itself.
CREATE TABLE sessions (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  token_hash   TEXT NOT NULL UNIQUE,
  created_at   TIMESTAMPTZ NOT NULL,
  last_seen_at TIMESTAMPTZ NOT NULL,
  expires_at   TIMESTAMPTZ NOT NULL,
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
