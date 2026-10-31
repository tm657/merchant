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

let stopping = false;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const loop = (async () => {
  while (!stopping) {
    let found = 0;
    try {
      found = await worker.runOnce(config.WEBHOOK_BATCH_SIZE);
    } catch (err) {
      log.error({ err }, "webhook step failed");
    }
    if (found === 0 && !stopping) await sleep(config.WEBHOOK_POLL_MS);
  }
})();
log.info({ batchSize: config.WEBHOOK_BATCH_SIZE, maxAttempts: WEBHOOK_MAX_ATTEMPTS }, "webhook worker started");

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    log.info("stopping: finishing in-flight deliveries");
    stopping = true;
    // Requests time out after 5 s; anything unfinished is retried when its lease expires.
    void Promise.race([loop, sleep(7000)])
      .then(() => db.end())
      .finally(() => process.exit(0));
  });
}
