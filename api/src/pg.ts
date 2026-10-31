import pg from "pg";

/** Postgres pool. Not used for app data yet: only migrations and /readyz touch it. */
export function createPgPool(connectionString: string): pg.Pool {
  return new pg.Pool({
    connectionString,
    max: 10,
    connectionTimeoutMillis: 2000,
    idleTimeoutMillis: 30_000,
  });
}
