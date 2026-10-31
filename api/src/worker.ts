/**
 * The pay-out worker process: npm run worker (or npm run dev:worker from the repo root).
 * - Claims approved pay-outs (SELECT ... FOR UPDATE SKIP LOCKED) and sends them to the
 *   simulated provider. Run as many of these processes as you like.
 * - Publishes the outbox to Redis, which the API instances relay to SSE clients.
 * - Deletes idempotency keys after 24 h and published outbox rows after 7 days.
 */
import Fastify from "fastify";
import { parseEnv, workerConfigSchema } from "./config.js";
import { assertAppRole, createDb } from "./db.js";
import { publishOutboxBatch, purgePublishedOutbox } from "./outbox.js";
import { createSimulatedProvider } from "./payouts/provider.js";
import { createPayoutWorker } from "./payouts/worker.js";
import { createRedis } from "./redis.js";

const config = parseEnv(workerConfigSchema);

// A Fastify instance only for its logger, so worker logs match the API's JSON format.
const log = Fastify({ logger: { level: config.LOG_LEVEL } }).log.child({ service: "worker" });

const db = createDb(config.DATABASE_URL);
const redis = createRedis(config.REDIS_URL);
db.on("error", (err) => log.error({ err }, "postgres pool error"));
await assertAppRole(db);
let redisDown = false;
redis.on("error", (err) => {
  if (!redisDown) log.warn({ err: err.message }, "redis unavailable, retrying in the background");
  redisDown = true;
});
redis.on("ready", () => {
  if (redisDown) log.info("redis reconnected");
  redisDown = false;
});

const worker = createPayoutWorker({
  db,
  log,
  leaseMs: config.PAYOUT_LEASE_MS,
  maxAttempts: config.PAYOUT_MAX_ATTEMPTS,
  providerTimeoutMs: Math.floor(config.PAYOUT_LEASE_MS / 2),
  provider: createSimulatedProvider({
    redis,
    minLatencyMs: config.PROVIDER_MIN_LATENCY_MS,
    maxLatencyMs: config.PROVIDER_MAX_LATENCY_MS,
    declineRate: config.PROVIDER_DECLINE_RATE,
    transientRate: config.PROVIDER_TRANSIENT_RATE,
  }),
});

let stopping = false;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Runs `step` until stopped: again at once while it finds work, after `idleMs` when it doesn't. */
async function loop(name: string, idleMs: number, step: () => Promise<number>) {
  while (!stopping) {
    let found = 0;
    try {
      found = await step();
    } catch (err) {
      log.error({ err }, `${name} step failed`);
    }
    if (found === 0 && !stopping) await sleep(idleMs);
  }
}

const HOUR = 60 * 60 * 1000;
async function cleanup() {
  try {
    const now = Date.now();
    const keys = await db.query("DELETE FROM idempotency_keys WHERE created_at < $1", [new Date(now - 24 * HOUR).toISOString()]);
    const outbox = await purgePublishedOutbox(db, new Date(now - 7 * 24 * HOUR).toISOString());
    if ((keys.rowCount ?? 0) + outbox > 0) log.info({ idempotencyKeys: keys.rowCount, outbox }, "cleaned up old rows");
  } catch (err) {
    log.error({ err }, "cleanup failed");
  }
}
void cleanup();
const cleanupTimer = setInterval(() => void cleanup(), 10 * 60 * 1000);

const loops = Promise.all([
  loop("payouts", config.WORKER_POLL_MS, () => worker.runOnce(config.WORKER_BATCH_SIZE)),
  loop("outbox", config.OUTBOX_POLL_MS, () => publishOutboxBatch(db, redis, { log })),
]);
log.info({ batchSize: config.WORKER_BATCH_SIZE }, "pay-out worker started");

// Long enough for an in-flight provider call (at most half the lease) to finish.
const SHUTDOWN_GRACE_MS = config.PAYOUT_LEASE_MS / 2 + 1000;

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    log.info("stopping: finishing in-flight work");
    stopping = true;
    clearInterval(cleanupTimer);
    // Anything still unfinished after the grace period is picked up again once its lease expires.
    void Promise.race([loops, sleep(SHUTDOWN_GRACE_MS)])
      .then(async () => {
        await publishOutboxBatch(db, redis, { log }).catch(() => 0);
        await db.end();
        redis.disconnect();
      })
      .finally(() => process.exit(0));
  });
}
