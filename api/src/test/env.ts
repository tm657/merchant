// Where tests run. They need the Postgres and Redis from docker-compose (npm run db:up)
// or CI's service containers, and use their own database (payments_test) and Redis db 15,
// never the dev data. Set TEST_DATABASE_URL / TEST_REDIS_URL to override.
import { z } from "zod";
import { parseEnv } from "../config.js";

const env = parseEnv(
  z.object({
    MIGRATION_DATABASE_URL: z.url().optional(),
    REDIS_URL: z.url().optional(),
    /** The schema owner in the test database (migrations, cleanup). */
    TEST_DATABASE_URL: z.url().optional(),
    TEST_REDIS_URL: z.url().optional(),
  }),
);

export function withPath(url: string, path: string): string {
  const u = new URL(url);
  u.pathname = path;
  return u.toString();
}

const ownerUrl = env.TEST_DATABASE_URL ?? (env.MIGRATION_DATABASE_URL && withPath(env.MIGRATION_DATABASE_URL, "/payments_test"));
const redisUrl = env.TEST_REDIS_URL ?? (env.REDIS_URL && withPath(env.REDIS_URL, "/15"));
if (!ownerUrl || !redisUrl) {
  throw new Error("Tests need Postgres and Redis: run `npm run db:up` and create api/.env from api/.env.example.");
}
if (env.MIGRATION_DATABASE_URL && new URL(ownerUrl).pathname === new URL(env.MIGRATION_DATABASE_URL).pathname) {
  throw new Error("TEST_DATABASE_URL must point at a different database than MIGRATION_DATABASE_URL.");
}

/** The schema owner in the test database: migrations, setup the app may not do, cleanup. */
export const TEST_DATABASE_URL: string = ownerUrl;
export const TEST_REDIS_URL: string = redisUrl;

/**
 * The app side of tests connects as its own login role, a member of payments_app, exactly
 * like the real API: not a superuser, not the owner. So tests exercise the real privileges.
 */
export const TEST_APP_URL = (() => {
  const u = new URL(TEST_DATABASE_URL);
  u.username = "payments_app_test";
  u.password = "payments_app_test";
  return u.toString();
})();

export const TEST_DATABASE_NAME = new URL(TEST_DATABASE_URL).pathname.slice(1);
