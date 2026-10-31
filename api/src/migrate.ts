import { runner } from "node-pg-migrate";
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
