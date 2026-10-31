-- Up Migration

-- ---- Application role --------------------------------------------------------
-- The API and workers connect as a login role that is a member of payments_app: no
-- superuser rights and no table ownership, so privileges actually bind it. Migrations
-- and the seed run as the owner (MIGRATION_DATABASE_URL). db:migrate creates the login
-- role from DATABASE_URL and grants it payments_app. Roles are cluster-wide, so this
-- tolerates the role already existing (including a parallel test run creating it).
DO $$
BEGIN
  CREATE ROLE payments_app NOLOGIN;
EXCEPTION
  WHEN duplicate_object OR unique_violation THEN NULL;
END
$$;

-- ---- Audit log ---------------------------------------------------------------
-- Append-only. No foreign keys: entries must outlive the users and orgs they mention.
-- org_id is NULL for user-level actions (login, logout).
CREATE TABLE audit_log (
  id          BIGSERIAL PRIMARY KEY,
  org_id      TEXT COLLATE "C",
  actor_id    TEXT COLLATE "C",           -- NULL: the system, or an unknown caller
  actor_label TEXT NOT NULL,              -- email at the time, or 'system' / 'anonymous'
  action      TEXT NOT NULL,              -- AUDIT_ACTIONS in @mini-payments/shared
  target_type TEXT,
  target_id   TEXT COLLATE "C",
  metadata    JSONB NOT NULL DEFAULT '{}'::jsonb,
  ip          INET,
  user_agent  TEXT,
  request_id  TEXT,
  created_at  TIMESTAMPTZ(3) NOT NULL
);
CREATE INDEX idx_audit_org_created ON audit_log (org_id, created_at, id);
CREATE INDEX idx_audit_actor_created ON audit_log (actor_id, created_at, id);
CREATE INDEX idx_audit_target ON audit_log (target_type, target_id);

CREATE FUNCTION audit_log_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit_log is append-only: % is not allowed', TG_OP;
END
$$;
-- Fires for every role, the owner included. TRUNCATE skips row triggers, hence its own.
CREATE TRIGGER audit_log_no_update_delete BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION audit_log_append_only();
CREATE TRIGGER audit_log_no_truncate BEFORE TRUNCATE ON audit_log
  FOR EACH STATEMENT EXECUTE FUNCTION audit_log_append_only();

-- ---- Webhooks ----------------------------------------------------------------
CREATE TABLE webhook_endpoints (
  id                         TEXT COLLATE "C" PRIMARY KEY,
  org_id                     TEXT COLLATE "C" NOT NULL REFERENCES orgs (id),
  url                        TEXT NOT NULL,
  description                TEXT NOT NULL DEFAULT '',
  enabled                    BOOLEAN NOT NULL DEFAULT true,
  events                     TEXT[] NOT NULL CHECK (cardinality(events) > 0),
  -- AES-256-GCM, 'v1:<iv>:<tag>:<ciphertext>' (base64url), endpoint id as AAD.
  secret_enc                 TEXT NOT NULL,
  -- After a rotation the old secret keeps signing (as a second v1=) until it expires.
  previous_secret_enc        TEXT,
  previous_secret_expires_at TIMESTAMPTZ(3),
  created_by                 TEXT COLLATE "C" NOT NULL REFERENCES users (id),
  created_at                 TIMESTAMPTZ(3) NOT NULL,
  updated_at                 TIMESTAMPTZ(3) NOT NULL,
  secret_rotated_at          TIMESTAMPTZ(3)
);
CREATE INDEX idx_webhook_endpoints_org ON webhook_endpoints (org_id, created_at, id);

CREATE TABLE webhook_deliveries (
  id                 TEXT COLLATE "C" PRIMARY KEY,
  org_id             TEXT COLLATE "C" NOT NULL REFERENCES orgs (id),
  endpoint_id        TEXT COLLATE "C" NOT NULL REFERENCES webhook_endpoints (id) ON DELETE CASCADE,
  event_id           TEXT COLLATE "C" NOT NULL,
  event_type         TEXT NOT NULL,
  -- The exact JSON sent, so every attempt (and a redelivery) has identical bytes.
  body               TEXT NOT NULL,
  status             TEXT NOT NULL CHECK (status IN ('pending', 'delivering', 'succeeded', 'dead')),
  attempts           INTEGER NOT NULL DEFAULT 0,  -- also the fencing token for a claim
  next_attempt_at    TIMESTAMPTZ(3),
  lease_expires_at   TIMESTAMPTZ(3),
  last_response_code INTEGER,
  last_error         TEXT,
  last_attempt_at    TIMESTAMPTZ(3),
  delivered_at       TIMESTAMPTZ(3),
  redelivery_of      TEXT COLLATE "C" REFERENCES webhook_deliveries (id) ON DELETE SET NULL,
  created_at         TIMESTAMPTZ(3) NOT NULL
);
-- Fan-out is idempotent: one original delivery per endpoint and event.
CREATE UNIQUE INDEX uq_webhook_deliveries_event ON webhook_deliveries (endpoint_id, event_id) WHERE redelivery_of IS NULL;
CREATE INDEX idx_webhook_deliveries_endpoint ON webhook_deliveries (endpoint_id, created_at, id);
CREATE INDEX idx_webhook_deliveries_due ON webhook_deliveries (next_attempt_at, id) WHERE status IN ('pending', 'delivering');

-- Webhook events travel through the outbox too.
ALTER TABLE outbox DROP CONSTRAINT outbox_type_check;
ALTER TABLE outbox ADD CONSTRAINT outbox_type_check CHECK (type IN ('payout', 'balance', 'webhook'));

-- ---- Privileges for the application role --------------------------------------
DO $$
DECLARE s text := current_schema();
BEGIN
  EXECUTE format('GRANT USAGE ON SCHEMA %I TO payments_app', s);
  EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA %I TO payments_app', s);
  EXECUTE format('GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA %I TO payments_app', s);
  -- Tables later migrations create get the same grants automatically.
  EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA %I GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO payments_app', s);
  EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA %I GRANT USAGE, SELECT ON SEQUENCES TO payments_app', s);
END
$$;
-- The app may read and append to the audit log, nothing else.
REVOKE UPDATE, DELETE, TRUNCATE ON audit_log FROM payments_app;
-- Migration bookkeeping is the owner's business.
REVOKE ALL ON pgmigrations FROM payments_app;

-- Down Migration

DO $$
DECLARE s text := current_schema();
BEGIN
  EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA %I REVOKE ALL ON TABLES FROM payments_app', s);
  EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA %I REVOKE ALL ON SEQUENCES FROM payments_app', s);
  EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA %I FROM payments_app', s);
  EXECUTE format('REVOKE ALL ON ALL SEQUENCES IN SCHEMA %I FROM payments_app', s);
  EXECUTE format('REVOKE USAGE ON SCHEMA %I FROM payments_app', s);
END
$$;
ALTER TABLE outbox DROP CONSTRAINT outbox_type_check;
DELETE FROM outbox WHERE type = 'webhook';
ALTER TABLE outbox ADD CONSTRAINT outbox_type_check CHECK (type IN ('payout', 'balance'));
DROP TABLE webhook_deliveries;
DROP TABLE webhook_endpoints;
-- Rolling back means dropping the log: the triggers would refuse anything less.
DROP TABLE audit_log;
DROP FUNCTION audit_log_append_only();
-- payments_app itself is left in place: roles are shared by every database on the server.
