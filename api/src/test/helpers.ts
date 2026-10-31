import type { Role } from "@mini-payments/shared";
import type { Redis } from "ioredis";
import { randomBytes, randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach } from "node:test";
import { z } from "zod";
import { buildApp } from "../app.js";
import { hashPassword } from "../auth/password.js";
import { parseEnv } from "../config.js";
import { assertAppRole, createDb, quoteIdent, type Db } from "../db.js";
import type { ReadinessCheck } from "../health.js";
import { ensureAppLogin, runMigrations } from "../migrate.js";
import { createRedis, createSubscriber } from "../redis.js";

export const PASSWORD = "correct horse battery staple";

/** A controllable clock: tests move time forward instead of waiting. */
export function fakeClock(start = Date.parse("2026-01-01T09:00:00.000Z")) {
  let now = start;
  return {
    now: () => now,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

// ---- Where tests run --------------------------------------------------------
// Tests need the Postgres and Redis from docker-compose (npm run db:up). They use a
// separate database (payments_test) and Redis db 15, never the dev data.

const env = parseEnv(
  z.object({
    DATABASE_URL: z.url().optional(),
    MIGRATION_DATABASE_URL: z.url().optional(),
    REDIS_URL: z.url().optional(),
    /** The schema owner in the test database (migrations, cleanup). */
    TEST_DATABASE_URL: z.url().optional(),
    TEST_REDIS_URL: z.url().optional(),
  }),
);

function withPath(url: string | undefined, path: string): string | undefined {
  if (!url) return undefined;
  const u = new URL(url);
  u.pathname = path;
  return u.toString();
}

const TEST_DATABASE_URL = env.TEST_DATABASE_URL ?? withPath(env.MIGRATION_DATABASE_URL, "/payments_test");
const TEST_REDIS_URL = env.TEST_REDIS_URL ?? withPath(env.REDIS_URL, "/15");
if (!TEST_DATABASE_URL || !TEST_REDIS_URL) {
  throw new Error("Tests need Postgres and Redis: run `npm run db:up` and create api/.env from api/.env.example.");
}
if (env.MIGRATION_DATABASE_URL && new URL(TEST_DATABASE_URL).pathname === new URL(env.MIGRATION_DATABASE_URL).pathname) {
  throw new Error("TEST_DATABASE_URL must point at a different database than DATABASE_URL.");
}

/**
 * The app connects as its own login role, a member of payments_app, exactly like the
 * real API: not a superuser, not the owner. So tests exercise the real privileges.
 */
const TEST_APP_URL = (() => {
  const u = new URL(TEST_DATABASE_URL);
  u.username = "payments_app_test";
  u.password = "payments_app_test";
  return u.toString();
})();

/** Export files go to a temp folder per test process. */
export const TEST_EXPORT_DIR = join(tmpdir(), `mini-payments-exports-${process.pid}`);

/** A key for webhook secrets, fresh per test process. */
export const TEST_WEBHOOK_KEY = randomBytes(32);
/** Tests talk to local servers, so private targets are allowed unless a test says otherwise. */
export const TEST_WEBHOOK_POLICY = { requireHttps: false, allowPrivate: true };

let testDbReady: Promise<void> | undefined;

/** Creates the test database once per process if it doesn't exist. */
function ensureTestDatabase(): Promise<void> {
  testDbReady ??= (async () => {
    const name = new URL(TEST_DATABASE_URL!).pathname.slice(1);
    const admin = createDb(withPath(TEST_DATABASE_URL, "/postgres")!, { max: 1 });
    try {
      const { rowCount } = await admin.query("SELECT 1 FROM pg_database WHERE datname = $1", [name]);
      if (!rowCount) {
        await admin.query(`CREATE DATABASE ${quoteIdent(name)}`).catch((err: { code?: string }) => {
          // Another test file created it at the same moment.
          if (err.code !== "42P04" && err.code !== "23505") throw err;
        });
      }
    } finally {
      await admin.end();
    }
    await ensureAppLogin(TEST_DATABASE_URL!, TEST_APP_URL);
  })();
  return testDbReady;
}

// Everything a test created is torn down after that test.
const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!().catch(() => {});
});

function waitReady(client: Redis): Promise<void> {
  if (client.status === "ready") return Promise.resolve();
  return new Promise((resolve, reject) => {
    client.once("ready", () => resolve());
    client.once("end", () => reject(new Error("redis connection ended")));
  });
}

/**
 * A fresh, migrated schema of its own in the test database. `db` is the app role (what
 * the API uses); `owner` is the schema owner, for setup the app may not do.
 */
export async function makeTestDb({ migrations }: { migrations?: number } = {}): Promise<{
  db: Db;
  owner: Db;
  schema: string;
  /** Applies the migrations skipped by `migrations` (for testing a migration's data changes). */
  migrateRest: () => Promise<void>;
}> {
  await ensureTestDatabase();
  const schema = `test_${randomUUID().replaceAll("-", "")}`;
  await runMigrations({ databaseUrl: TEST_DATABASE_URL!, schema, lock: false, count: migrations });
  const owner = createDb(TEST_DATABASE_URL!, { schema, max: 2 });
  const db = createDb(TEST_APP_URL, { schema, max: 3 });
  cleanups.push(async () => {
    await db.end();
    await owner.query(`DROP SCHEMA ${quoteIdent(schema)} CASCADE`);
    await owner.end();
  });
  // Before the role migration there is nothing for the app role to be checked against.
  if (migrations === undefined) await assertAppRole(db);
  const migrateRest = async () => {
    await runMigrations({ databaseUrl: TEST_DATABASE_URL!, schema, lock: false });
  };
  return { db, owner, schema, migrateRest };
}

/** Redis connections plus a key prefix nobody else uses. Keys are deleted afterwards. */
export async function makeTestRedis(prefix = `test:${randomUUID()}:`) {
  const redis = createRedis(TEST_REDIS_URL!);
  const subscriber = createSubscriber(TEST_REDIS_URL!);
  await Promise.all([waitReady(redis), waitReady(subscriber)]);
  cleanups.push(async () => {
    const keys = await redis.keys(`${prefix}*`);
    if (keys.length > 0) await redis.del(...keys);
    subscriber.disconnect();
    redis.disconnect();
  });
  return { redis, subscriber, prefix };
}

/** Redis clients pointed at a port nothing listens on, for "Redis is down" tests. */
export function deadRedis() {
  const url = "redis://127.0.0.1:1";
  const redis = createRedis(url);
  const subscriber = createSubscriber(url);
  for (const c of [redis, subscriber]) c.on("error", () => {});
  cleanups.push(async () => {
    subscriber.disconnect();
    redis.disconnect();
  });
  return { redis, subscriber };
}

type TestAppOptions = {
  /** Reuse another test app's database (two API instances sharing one Postgres). */
  db?: Db;
  owner?: Db;
  webhookPolicy?: { requireHttps: boolean; allowPrivate: boolean };
  /** Reuse a Redis prefix (two API instances sharing one Redis). */
  redisPrefix?: string;
  /** Use these Redis clients instead of real ones (e.g. deadRedis()). */
  redisClients?: { redis: Redis; subscriber: Redis };
  readiness?: Record<string, ReadinessCheck>;
  logger?: Parameters<typeof buildApp>[0]["logger"];
};

/**
 * Fresh database schema, Redis prefix and app. Users:
 *   admin@test (org_1 admin), multi@test (org_1 finance + org_2 admin),
 *   support@test (org_1 support), loner@test (no orgs).
 */
export async function makeTestApp(clock = fakeClock(), opts: TestAppOptions = {}) {
  const testDb = opts.db ? { db: opts.db, owner: opts.owner } : await makeTestDb();
  if (!opts.db) await seedFixtures(testDb.db, clock);
  const { db, owner } = testDb;
  const { redis, subscriber, prefix: redisPrefix } = opts.redisClients
    ? { ...opts.redisClients, prefix: opts.redisPrefix ?? `test:${randomUUID()}:` }
    : await makeTestRedis(opts.redisPrefix);

  const { app, bus } = buildApp({
    db,
    redis,
    subscriber,
    clock: clock.now,
    redisPrefix,
    readiness: opts.readiness,
    logger: opts.logger,
    webhookKey: TEST_WEBHOOK_KEY,
    webhookPolicy: opts.webhookPolicy ?? TEST_WEBHOOK_POLICY,
    exportDir: TEST_EXPORT_DIR,
  });
  cleanups.push(() => app.close());

  async function login(email: string, password = PASSWORD, ip = "10.0.0.1") {
    return app.inject({ method: "POST", url: "/auth/login", payload: { email, password }, remoteAddress: ip });
  }

  async function tokenFor(email: string): Promise<string> {
    const res = await login(email);
    if (res.statusCode !== 200) throw new Error(`login failed: ${res.statusCode} ${res.body}`);
    return (res.json() as { token: string }).token;
  }

  const get = (url: string, token?: string) =>
    app.inject({ method: "GET", url, headers: token ? { authorization: `Bearer ${token}` } : {} });

  return { app, bus, db, owner: owner!, redis, redisPrefix, clock, login, tokenFor, get };
}

async function seedFixtures(db: Db, clock: ReturnType<typeof fakeClock>): Promise<Db> {
  const hash = await hashPassword(PASSWORD);
  const now = new Date(clock.now()).toISOString();

  for (const org of ["org_1", "org_2", "org_3"]) await db.query("INSERT INTO orgs (id, name) VALUES ($1, $1)", [org]);
  await db.query("INSERT INTO balances (org_id, currency, available, updated_at) VALUES ('org_1', 'USD', 1000, $1)", [now]);

  // Display names differ from ids and emails, so tests can tell which one is shown.
  const users: [id: string, email: string, name: string, memberships: [string, Role][]][] = [
    ["u_admin", "admin@test.com", "Ada Admin", [["org_1", "admin"]]],
    ["u_multi", "multi@test.com", "Max Multi", [["org_1", "finance"], ["org_2", "admin"]]],
    ["u_support", "support@test.com", "Sam Support", [["org_1", "support"]]],
    ["u_loner", "loner@test.com", "Lee Loner", []],
  ];
  for (const [id, email, name, memberships] of users) {
    await db.query("INSERT INTO users (id, email, name, password_hash, created_at) VALUES ($1, $2, $3, $4, $5)", [
      id,
      email,
      name,
      hash,
      now,
    ]);
    for (const [org, role] of memberships) {
      await db.query("INSERT INTO memberships (user_id, org_id, role) VALUES ($1, $2, $3)", [id, org, role]);
    }
  }
  return db;
}
