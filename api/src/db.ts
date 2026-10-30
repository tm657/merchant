import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const CURRENCIES = ["USD", "IDR", "PHP"] as const;
export type Currency = (typeof CURRENCIES)[number];

export const STATUSES = ["pending", "success", "failed"] as const;
export type Status = (typeof STATUSES)[number];

const DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "data");
export const DB_PATH = process.env.DB_PATH ?? join(DATA_DIR, "payments.db");

const SCHEMA = `
CREATE TABLE IF NOT EXISTS orgs (
  id   TEXT PRIMARY KEY,
  name TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS transactions (
  id         TEXT PRIMARY KEY,
  org_id     TEXT NOT NULL REFERENCES orgs(id),
  merchant   TEXT NOT NULL,
  amount     INTEGER NOT NULL CHECK (amount >= 0 AND typeof(amount) = 'integer'),
  currency   TEXT NOT NULL CHECK (currency IN ('USD', 'IDR', 'PHP')),
  status     TEXT NOT NULL CHECK (status IN ('pending', 'success', 'failed')),
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_tx_org_created ON transactions (org_id, created_at, id);
CREATE INDEX IF NOT EXISTS idx_tx_org_amount  ON transactions (org_id, amount, id);

CREATE TABLE IF NOT EXISTS balances (
  org_id     TEXT NOT NULL REFERENCES orgs(id),
  currency   TEXT NOT NULL CHECK (currency IN ('USD', 'IDR', 'PHP')),
  available  INTEGER NOT NULL CHECK (typeof(available) = 'integer'),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (org_id, currency)
);
`;

export function openDb(path: string = DB_PATH): Database.Database {
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(SCHEMA);
  return db;
}
