import { runner } from "node-pg-migrate";
import pg from "pg";
import { quoteIdent } from "./db.js";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");

type Options = {
  databaseUrl: string;
  direction?: "up" | "down";
  count?: number;
  /** Schema to migrate (created if missing). Default: public. */
  schema?: string;
  log?: (msg: string) => void;
  /**
   * Take node-pg-migrate's database-wide advisory lock (default). Tests turn it off:
   * each migrates its own throwaway schema, and parallel test files would collide on it.
   */
  lock?: boolean;
};

/** Applies (or rolls back) the SQL migrations in api/migrations. */
export function runMigrations({ databaseUrl, direction = "up", count, schema, log = () => {}, lock = true }: Options) {
  return runner({
    databaseUrl,
    dir: MIGRATIONS_DIR,
    direction,
    // Default: all pending going up, only the last one going down.
    count: count ?? (direction === "up" ? Infinity : 1),
    migrationsTable: "pgmigrations",
    ...(schema ? { schema, createSchema: true, migrationsSchema: schema } : {}),
    // Each migration runs in its own transaction; a failure rolls back just that one.
    singleTransaction: false,
    checkOrder: true,
    noLock: !lock,
    log,
  });
}

/** Creates or updates the login role in DATABASE_URL and grants it payments_app. */
export async function ensureAppLogin(ownerUrl: string, appUrl: string): Promise<string> {
  const app = new URL(appUrl);
  const owner = new URL(ownerUrl);
  const user = decodeURIComponent(app.username);
  const password = decodeURIComponent(app.password);
  if (!user || !password) throw new Error("DATABASE_URL needs a user and a password for the application role.");
  if (user === decodeURIComponent(owner.username)) {
    throw new Error("DATABASE_URL must use the application role, not the owner in MIGRATION_DATABASE_URL.");
  }
  const client = new pg.Client({ connectionString: ownerUrl });
  await client.connect();
  // Roles are server-wide: serialize role changes across concurrent runs (parallel tests).
  await client.query("SELECT pg_advisory_lock(hashtext('mini-payments:roles'))");
  try {
    const exists = (await client.query("SELECT 1 FROM pg_roles WHERE rolname = $1", [user])).rowCount;
    // CREATE/ALTER ROLE can't take bind parameters, so quote the name and password safely.
    const attrs = `LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS PASSWORD ${client.escapeLiteral(password)}`;
    await client.query(`${exists ? "ALTER" : "CREATE"} ROLE ${quoteIdent(user)} WITH ${attrs}`);
    // The group role is created by the first migration that needs it.
    await client.query(`DO $$ BEGIN CREATE ROLE payments_app NOLOGIN; EXCEPTION WHEN duplicate_object OR unique_violation THEN NULL; END $$`);
    await client.query(`GRANT payments_app TO ${quoteIdent(user)}`);
    // No DDL through the back door: nobody but the owner may create schemas or temp
    // tables in this database (PUBLIC has TEMP by default). The app still connects.
    const { rows } = await client.query<{ db: string }>("SELECT current_database() AS db");
    const db = quoteIdent(rows[0]!.db);
    await client.query(`REVOKE CREATE, TEMPORARY ON DATABASE ${db} FROM PUBLIC`);
    await client.query(`GRANT CONNECT ON DATABASE ${db} TO payments_app`);
    await client.query("REVOKE CREATE ON SCHEMA public FROM PUBLIC");
    return user;
  } finally {
    await client.query("SELECT pg_advisory_unlock(hashtext('mini-payments:roles'))").catch(() => {});
    await client.end();
  }
}

