/**
 * The webhook delivery worker: npm run webhooks (or npm run dev:webhooks from the repo
 * root). Claims due deliveries with FOR UPDATE SKIP LOCKED, so any number can run.
 * Deliveries are created by the outbox publisher in the pay-out worker (npm run worker).
 */
import { WEBHOOK_MAX_ATTEMPTS } from "@mini-payments/shared";
import Fastify from "fastify";
import { parseEnv, webhookWorkerConfigSchema } from "./config.js";
import { assertAppRole, createDb } from "./db.js";
import { parseSecretKey } from "./webhooks/crypto.js";
import { createDeliveryWorker } from "./webhooks/delivery.js";
import { handleShutdown, sleepUnless } from "./shutdown.js";

const config = parseEnv(webhookWorkerConfigSchema);
const log = Fastify({ logger: { level: config.LOG_LEVEL } }).log.child({ service: "webhooks" });

const db = createDb(config.DATABASE_URL);
db.on("error", (err) => log.error({ err }, "postgres pool error"));
await assertAppRole(db);

const policy = { requireHttps: config.NODE_ENV === "production", allowPrivate: config.WEBHOOK_ALLOW_PRIVATE_TARGETS };
if (policy.allowPrivate) log.warn("WEBHOOK_ALLOW_PRIVATE_TARGETS is on: webhooks may reach loopback and private addresses");

const worker = createDeliveryWorker({
  db,
  key: parseSecretKey(config.WEBHOOK_SECRET_KEY),
  policy,
  log,
  leaseMs: config.WEBHOOK_LEASE_MS,
  backoffBaseMs: config.WEBHOOK_BACKOFF_BASE_MS,
});

// Aborted on shutdown: no new claims, idle waits end at once.
const stop = new AbortController();

const loop = (async () => {
  while (!stop.signal.aborted) {
    let found = 0;
    try {
      found = await worker.runOnce(config.WEBHOOK_BATCH_SIZE);
    } catch (err) {
      log.error({ err }, "webhook step failed");
    }
    if (found === 0) await sleepUnless(config.WEBHOOK_POLL_MS, stop.signal);
  }
})();
log.info({ batchSize: config.WEBHOOK_BATCH_SIZE, maxAttempts: WEBHOOK_MAX_ATTEMPTS }, "webhook worker started");

// Stop claiming and let in-flight deliveries finish (each times out after 5 s), then close.
handleShutdown({
  log,
  graceMs: 10_000,
  stop: async () => {
    stop.abort();
    await loop;
    await db.end();
  },
});
