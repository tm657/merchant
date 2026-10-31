/**
 * Runs the SQL migrations in api/migrations as the schema owner (MIGRATION_DATABASE_URL),
 * then makes sure the application login role from DATABASE_URL exists, can log in with
 * that password, and is a member of payments_app (whose privileges the migrations set).
 *
 *   npm run db:migrate              apply all pending migrations
 *   npm run db:migrate -- up 1      apply the next one
 *   npm run db:migrate -- down      roll back the last one
 *   npm run db:migrate -- down 2    roll back the last two
 */
import { z } from "zod";
import { migrationConfigSchema, parseEnv } from "../src/config.js";
import { ensureAppLogin, runMigrations } from "../src/migrate.js";

const args = z
  .tuple([z.enum(["up", "down"]).default("up"), z.coerce.number().int().positive().optional()])
  .safeParse([process.argv[2], process.argv[3]]);
if (!args.success) {
  console.error("Usage: npm run db:migrate -- [up|down] [count]");
  process.exit(1);
}
const [direction, count] = args.data;

const { DATABASE_URL, MIGRATION_DATABASE_URL } = parseEnv(migrationConfigSchema);

try {
  const ran = await runMigrations({ databaseUrl: MIGRATION_DATABASE_URL, direction, count, log: (msg) => console.log(msg) });
  console.log(ran.length === 0 ? "No migrations to run." : `Ran ${ran.length} migration(s) ${direction}.`);
  // After rolling everything back payments_app may not have privileges anywhere; it
  // still exists (roles are server-wide), so the login role is kept in step either way.
  console.log(`Application role "${await ensureAppLogin(MIGRATION_DATABASE_URL, DATABASE_URL)}" is ready.`);
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
}

