/**
 * Prepares the e2e stack's own database and Redis db before Playwright starts the apps
 * (npm run test:e2e runs this first). Never touches the dev database:
 *   - drops and recreates the database named in e2e/stack.json, migrates it, creates its
 *     app login role, and seeds it (passwords in e2e/.cache/seed-users.local.json);
 *   - empties its Redis db and the e2e export folder.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, rmSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Redis } from "ioredis";
import pg from "pg";
import { z } from "zod";
import { parseEnv } from "../src/config.js";
import { quoteIdent } from "../src/db.js";
import { ensureAppLogin, runMigrations } from "../src/migrate.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const stack = JSON.parse(readFileSync(join(ROOT, "e2e", "stack.json"), "utf8")) as {
  database: string;
  appRole: string;
  appPassword: string;
  redisDb: number;
};
const env = parseEnv(z.object({ MIGRATION_DATABASE_URL: z.url(), REDIS_URL: z.url() }));

const withDb = (url: string, db: string, user?: { name: string; password: string }) => {
  const u = new URL(url);
  u.pathname = `/${db}`;
  if (user) {
    u.username = user.name;
    u.password = user.password;
  }
  return u.toString();
};
const ownerUrl = withDb(env.MIGRATION_DATABASE_URL, stack.database);
const appUrl = withDb(env.MIGRATION_DATABASE_URL, stack.database, { name: stack.appRole, password: stack.appPassword });
const redisUrl = (() => {
  const u = new URL(env.REDIS_URL);
  u.pathname = `/${stack.redisDb}`;
  return u.toString();
})();

const admin = new pg.Client({ connectionString: withDb(env.MIGRATION_DATABASE_URL, "postgres") });
await admin.connect();
await admin.query(`DROP DATABASE IF EXISTS ${quoteIdent(stack.database)} WITH (FORCE)`);
await admin.query(`CREATE DATABASE ${quoteIdent(stack.database)}`);
await admin.end();

const ran = await runMigrations({ databaseUrl: ownerUrl });
await ensureAppLogin(ownerUrl, appUrl);

const cache = join(ROOT, "e2e", ".cache");
mkdirSync(cache, { recursive: true });
const passwordsFile = join(cache, "seed-users.local.json");
rmSync(passwordsFile, { force: true });
execFileSync("npx", ["tsx", "src/seed.ts"], {
  cwd: join(ROOT, "api"),
  stdio: ["ignore", "ignore", "inherit"],
  env: { ...process.env, MIGRATION_DATABASE_URL: ownerUrl, DATABASE_URL: appUrl, SEED_USERS_FILE: passwordsFile },
});

const redis = new Redis(redisUrl, { lazyConnect: true });
await redis.connect();
await redis.flushdb();
redis.disconnect();
rmSync(join(cache, "exports"), { recursive: true, force: true });

console.log(`e2e: ${stack.database} recreated (${ran.length} migrations), seeded; Redis db ${stack.redisDb} flushed`);
