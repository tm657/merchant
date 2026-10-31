import pg from "pg";

export type Db = pg.Pool;
/** Anything that can run a query: the pool, or a client inside a transaction. */
export type Queryable = Pick<pg.Pool | pg.PoolClient, "query">;

const INT8_OID = 20;
const TIMESTAMPTZ_OID = 1184;
const DATE_OID = 1082;

/** BIGINT as a JS number. Refuses values a number can't hold exactly, instead of rounding money. */
export function parseBigint(value: string): number {
  const n = Number(value);
  if (!Number.isSafeInteger(n)) throw new RangeError(`BIGINT ${value} is outside the safe integer range`);
  return n;
}

const parseTimestamptz = pg.types.getTypeParser(TIMESTAMPTZ_OID) as (value: string) => Date;

/** Per-pool type parsers, so nothing global is patched. */
const types = {
  getTypeParser: ((oid: number, format?: "text" | "binary") => {
    if (oid === INT8_OID) return parseBigint;
    // Always an ISO 8601 UTC string with milliseconds, e.g. 2026-01-01T09:00:00.000Z.
    if (oid === TIMESTAMPTZ_OID) return (value: string) => parseTimestamptz(value).toISOString();
    // A calendar date stays the string Postgres sent (YYYY-MM-DD): no timezone to shift it.
    if (oid === DATE_OID) return (value: string) => value;
    return pg.types.getTypeParser(oid, format);
  }) as typeof pg.types.getTypeParser,
};

export type DbOptions = {
  /** Postgres schema to use instead of public (tests use one per app). */
  schema?: string;
  max?: number;
};

export function createDb(connectionString: string, { schema, max = 10 }: DbOptions = {}): Db {
  return new pg.Pool({
    connectionString,
    max,
    connectionTimeoutMillis: 2000,
    idleTimeoutMillis: 30_000,
    types,
    ...(schema ? { options: `-c search_path=${quoteIdent(schema)}` } : {}),
  });
}

export function quoteIdent(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

/** Runs `fn` in a transaction: COMMIT if it resolves, ROLLBACK if it throws. */
export async function withTransaction<T>(
  db: Db,
  fn: (client: pg.PoolClient) => Promise<T>,
  { isolation }: { isolation?: "REPEATABLE READ" | "SERIALIZABLE" } = {},
): Promise<T> {
  const client = await db.connect();
  try {
    await client.query(isolation ? `BEGIN ISOLATION LEVEL ${isolation}` : "BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Refuses to run as a superuser or as an owner of the app's tables: either would ignore
 * the privileges that keep audit_log append-only. Call once at startup.
 */
export async function assertAppRole(db: Queryable): Promise<void> {
  const { rows } = await db.query<{ role: string; superuser: boolean; owns: boolean }>(
    `SELECT current_user AS role,
            (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) AS superuser,
            EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = current_schema() AND tableowner = current_user) AS owns`,
  );
  const r = rows[0]!;
  if (r.superuser || r.owns) {
    throw new Error(
      `DATABASE_URL connects as "${r.role}", which is ${r.superuser ? "a superuser" : "the owner of the tables"}. ` +
        "Use the application role instead (see api/.env.example) and run npm run db:migrate to create it.",
    );
  }
}
