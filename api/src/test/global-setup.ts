/**
 * Runs once before the whole Vitest suite:
 *   1. drops and recreates the test database, so every run starts from nothing;
 *   2. runs every migration up, then all the way down, then up again, so a migration
 *      that can't be rolled back fails the suite (and CI);
 *   3. creates the test app login role (a member of payments_app).
 * Each test then migrates a throwaway schema of its own in this database (helpers.ts).
 */
import { quoteIdent } from "../db.js";
import { ensureAppLogin, runMigrations } from "../migrate.js";
import pg from "pg";
import { TEST_APP_URL, TEST_DATABASE_NAME, TEST_DATABASE_URL, withPath } from "./env.js";

export default async function setup() {
  const admin = new pg.Client({ connectionString: withPath(TEST_DATABASE_URL, "/postgres") });
  await admin.connect();
  try {
    await admin.query(`DROP DATABASE IF EXISTS ${quoteIdent(TEST_DATABASE_NAME)} WITH (FORCE)`);
    await admin.query(`CREATE DATABASE ${quoteIdent(TEST_DATABASE_NAME)}`);
  } finally {
    await admin.end();
  }

  const up = await runMigrations({ databaseUrl: TEST_DATABASE_URL });
  const down = await runMigrations({ databaseUrl: TEST_DATABASE_URL, direction: "down", count: Infinity });
  const again = await runMigrations({ databaseUrl: TEST_DATABASE_URL });
  if (up.length === 0 || down.length !== up.length || again.length !== up.length) {
    throw new Error(`migrations didn't round-trip: up ${up.length}, down ${down.length}, up again ${again.length}`);
  }
  await ensureAppLogin(TEST_DATABASE_URL, TEST_APP_URL);
  console.log(`test database ${TEST_DATABASE_NAME}: ${up.length} migrations applied, rolled back and re-applied`);
}
