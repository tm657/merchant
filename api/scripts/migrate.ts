/**
 * Runs the SQL migrations in api/migrations against DATABASE_URL.
 *
 *   npm run db:migrate              apply all pending migrations
 *   npm run db:migrate -- up 1      apply the next one
 *   npm run db:migrate -- down      roll back the last one
 *   npm run db:migrate -- down 2    roll back the last two
 */
import { z } from "zod";
import { configSchema, parseEnv } from "../src/config.js";
import { runMigrations } from "../src/migrate.js";

const args = z
  .tuple([z.enum(["up", "down"]).default("up"), z.coerce.number().int().positive().optional()])
  .safeParse([process.argv[2], process.argv[3]]);
if (!args.success) {
  console.error("Usage: npm run db:migrate -- [up|down] [count]");
  process.exit(1);
}
const [direction, count] = args.data;

const { DATABASE_URL } = parseEnv(configSchema.pick({ DATABASE_URL: true }));

try {
  const ran = await runMigrations({ databaseUrl: DATABASE_URL, direction, count, log: (msg) => console.log(msg) });
  console.log(ran.length === 0 ? "No migrations to run." : `Ran ${ran.length} migration(s) ${direction}.`);
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
}
