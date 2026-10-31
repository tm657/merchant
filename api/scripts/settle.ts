/**
 * Recomputes settlements by hand (the reports worker does it daily).
 *
 *   npm run settle                         the daily window (last 7 settled days through yesterday)
 *   npm run settle -- 2026-10-01 2026-10-30
 */
import { z } from "zod";
import { configSchema, parseEnv } from "../src/config.js";
import { createDb } from "../src/db.js";
import { dailyWindow, settle, utcDate } from "../src/settlements.js";

const args = z.tuple([z.iso.date().optional(), z.iso.date().optional()]).safeParse([process.argv[2], process.argv[3]]);
if (!args.success) {
  console.error("Usage: npm run settle -- [from YYYY-MM-DD] [to YYYY-MM-DD]");
  process.exit(1);
}
const { DATABASE_URL } = parseEnv(configSchema.pick({ DATABASE_URL: true }));
const db = createDb(DATABASE_URL, { max: 2 });
try {
  const [from, to] = args.data;
  const window = from ? { from, to: to ?? utcDate(Date.now() - 86_400_000) } : await dailyWindow(db);
  if (!window) console.log("Nothing to settle.");
  else {
    const result = await settle(db, window);
    console.log(result.status === "skipped" ? "Another instance is settling right now; skipped." : `Settled ${result.from} to ${result.to}: ${result.rows} row(s).`);
  }
} finally {
  await db.end();
}
