/**
 * The reports worker: npm run reports (or npm run dev:reports from the repo root).
 * - Claims queued CSV exports (FOR UPDATE SKIP LOCKED, at most 2 running per org via Redis)
 *   and streams them into EXPORT_DIR.
 * - Every 10 minutes: deletes exports past their 24 h expiry.
 * - Daily at SETTLEMENT_RUN_AT (UTC), and once at startup: recomputes settlements under an
 *   advisory lock, so with several instances only one does the work.
 * Run any number of these; the API must see the same EXPORT_DIR to serve downloads.
 */
import Fastify from "fastify";
import { parseEnv, reportsWorkerConfigSchema } from "./config.js";
import { assertAppRole, createDb } from "./db.js";
import { createExportWorker } from "./exports/worker.js";
import { createRedis } from "./redis.js";
import { closeRedis, handleShutdown, sleepUnless } from "./shutdown.js";
import { dailyWindow, settle } from "./settlements.js";

const config = parseEnv(reportsWorkerConfigSchema);
const log = Fastify({ logger: { level: config.LOG_LEVEL } }).log.child({ service: "reports" });

const db = createDb(config.DATABASE_URL);
db.on("error", (err) => log.error({ err }, "postgres pool error"));
await assertAppRole(db);
const redis = createRedis(config.REDIS_URL);
let redisDown = false;
redis.on("error", (err) => {
  if (!redisDown) log.warn({ err: err.message }, "redis unavailable, retrying in the background");
  redisDown = true;
});
redis.on("ready", () => {
  if (redisDown) log.info("redis reconnected");
  redisDown = false;
});

const exportsWorker = createExportWorker({
  db,
  redis,
  exportDir: config.EXPORT_DIR,
  log,
  maxRows: config.EXPORT_MAX_ROWS,
  maxBytes: config.EXPORT_MAX_BYTES,
  leaseMs: config.EXPORT_LEASE_MS,
});

// Aborted on shutdown: no new claims, idle waits end, and running exports stop between
// pages and go back to the queue (another worker picks them up at once).
const stop = new AbortController();
const timers: NodeJS.Timeout[] = [];

const exportLoop = (async () => {
  while (!stop.signal.aborted) {
    let found = 0;
    try {
      // Up to 2 at a time in this process; the per-org limit is enforced in Redis.
      found = await exportsWorker.runOnce(2, stop.signal);
    } catch (err) {
      log.error({ err }, "export step failed");
    }
    if (found === 0) await sleepUnless(config.EXPORT_POLL_MS, stop.signal);
  }
})();

async function cleanup() {
  try {
    const { expired, strays } = await exportsWorker.cleanup();
    if (expired + strays > 0) log.info({ expired, strays }, "removed expired export files");
  } catch (err) {
    log.error({ err }, "export cleanup failed");
  }
}
void cleanup();
timers.push(setInterval(() => void cleanup(), 10 * 60 * 1000));

let settling: Promise<void> = Promise.resolve();
function runSettlement() {
  settling = settleOnce();
  return settling;
}
async function settleOnce() {
  try {
    const window = await dailyWindow(db);
    if (!window) return log.info("settlements: nothing to settle");
    const result = await settle(db, window);
    if (result.status === "skipped") log.info("settlements: another instance holds the lock, skipped");
    else log.info(result, "settlements computed");
  } catch (err) {
    log.error({ err }, "settlement run failed");
  }
}

/** Milliseconds until the next HH:MM UTC. */
function untilNext(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number) as [number, number];
  const now = new Date();
  const next = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), h, m);
  return next > now.getTime() ? next - now.getTime() : next + 86_400_000 - now.getTime();
}
function scheduleSettlement() {
  timers.push(
    setTimeout(() => {
      void runSettlement().finally(() => {
        if (!stop.signal.aborted) scheduleSettlement();
      });
    }, untilNext(config.SETTLEMENT_RUN_AT)),
  );
}
void runSettlement();
scheduleSettlement();
log.info({ settlementRunAt: `${config.SETTLEMENT_RUN_AT} UTC`, exportDir: config.EXPORT_DIR }, "reports worker started");

// Stop claiming; running exports requeue themselves at the next page; a settlement in
// progress finishes (it's one transaction). Then close.
handleShutdown({
  log,
  graceMs: 15_000,
  stop: async () => {
    stop.abort();
    for (const t of timers) clearTimeout(t);
    await Promise.all([exportLoop, settling]);
    await db.end();
    await closeRedis(redis);
  },
});
