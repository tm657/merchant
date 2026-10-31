/**
 * Runs SQL migrations from api/migrations against DATABASE_URL.
 *
 *   npm run migrate              apply all pending migrations
 *   npm run migrate -- up 1      apply the next one
 *   npm run migrate -- down      roll back the last one
 *   npm run migrate -- down 2    roll back the last two
 */
import { runner } from "node-pg-migrate";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { configSchema, parseEnv } from "../src/config.js";

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");

const args = z
  .tuple([z.enum(["up", "down"]).default("up"), z.coerce.number().int().positive().optional()])
  .safeParse([process.argv[2], process.argv[3]]);
if (!args.success) {
  console.error("Usage: npm run migrate -- [up|down] [count]");
  process.exit(1);
}
const [direction, count] = args.data;

const { DATABASE_URL } = parseEnv(configSchema.pick({ DATABASE_URL: true }));

try {
  const ran = await runner({
    databaseUrl: DATABASE_URL,
    dir: MIGRATIONS_DIR,
    direction,
    // Default: all pending going up, only the last one going down.
    count: count ?? (direction === "up" ? Infinity : 1),
    migrationsTable: "pgmigrations",
    // Each migration runs in its own transaction; a failure rolls back just that one.
    singleTransaction: false,
    checkOrder: true,
    log: (msg) => console.log(msg),
  });
  console.log(ran.length === 0 ? "No migrations to run." : `Ran ${ran.length} migration(s) ${direction}.`);
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
}
