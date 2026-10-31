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
 * Refuses to run with more privilege than the app needs. The app role may read and write
 * rows, and nothing else: no superuser, no role attributes, not the owner (or a member of
 * the owner) of any table, no DDL (CREATE on the database or schema, TEMP), no TRUNCATE,
 * REFERENCES or TRIGGER on any table, and no UPDATE or DELETE on the audit log.
 * Call once at startup; it throws with every problem found.
 */
export async function assertAppRole(db: Queryable): Promise<void> {
  const { rows } = await db.query<{
    role: string;
    superuser: boolean;
    attributes: string[];
    owns: string[];
    owner_member: boolean;
    db_create: boolean;
    db_temp: boolean;
    schema_create: boolean;
    table_privileges: string[];
    audit_write: boolean;
  }>(
    `WITH me AS (SELECT * FROM pg_roles WHERE rolname = current_user),
          app_tables AS (SELECT c.oid, c.relname FROM pg_class c
                         WHERE c.relnamespace = current_schema()::regnamespace AND c.relkind IN ('r', 'p'))
     SELECT current_user AS role,
            (SELECT rolsuper FROM me) AS superuser,
            ARRAY(SELECT a FROM me, LATERAL (VALUES
                    (CASE WHEN rolcreaterole THEN 'CREATEROLE' END), (CASE WHEN rolcreatedb THEN 'CREATEDB' END),
                    (CASE WHEN rolreplication THEN 'REPLICATION' END), (CASE WHEN rolbypassrls THEN 'BYPASSRLS' END)) v(a)
                  WHERE a IS NOT NULL) AS attributes,
            ARRAY(SELECT t.relname::text FROM app_tables t JOIN pg_class c ON c.oid = t.oid
                  WHERE pg_has_role(current_user, c.relowner, 'USAGE')) AS owns,
            EXISTS (SELECT 1 FROM app_tables t JOIN pg_class c ON c.oid = t.oid
                    WHERE c.relowner <> (SELECT oid FROM me) AND pg_has_role(current_user, c.relowner, 'MEMBER')) AS owner_member,
            has_database_privilege(current_database(), 'CREATE') AS db_create,
            has_database_privilege(current_database(), 'TEMP') AS db_temp,
            has_schema_privilege(current_schema(), 'CREATE') AS schema_create,
            ARRAY(SELECT relname || ':' || p FROM app_tables, unnest(ARRAY['TRUNCATE', 'REFERENCES', 'TRIGGER']) p
                  WHERE has_table_privilege(oid, p)) AS table_privileges,
            COALESCE((SELECT has_table_privilege(oid, 'UPDATE') OR has_table_privilege(oid, 'DELETE')
                      FROM app_tables WHERE relname = 'audit_log'), false) AS audit_write`,
  );
  const r = rows[0]!;
  const problems = [
    r.superuser && "is a superuser",
    r.attributes.length > 0 && `has ${r.attributes.join(", ")}`,
    r.owns.length > 0 && `owns ${r.owns.slice(0, 3).join(", ")}${r.owns.length > 3 ? ", …" : ""}`,
    r.owner_member && "is a member of the tables' owner",
    r.db_create && "can CREATE on the database",
    r.db_temp && "can create TEMP tables",
    r.schema_create && "can CREATE in the schema",
    r.table_privileges.length > 0 && `has ${r.table_privileges.slice(0, 3).join(", ")}${r.table_privileges.length > 3 ? ", …" : ""}`,
    r.audit_write && "can UPDATE or DELETE audit_log",
  ].filter(Boolean);
  if (problems.length > 0) {
    throw new Error(
      `DATABASE_URL connects as "${r.role}", which ${problems.join("; ")}. ` +
        "Use the application role (see api/.env.example) and run npm run db:migrate to set it up.",
    );
  }
}
