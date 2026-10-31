import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { assertAppRole, createDb } from "./db.js";
import { createRedis, createSubscriber } from "./redis.js";
import { handleShutdown, sleep } from "./shutdown.js";
import { startSimulator } from "./simulator.js";
import { parseSecretKey } from "./webhooks/crypto.js";

// Exits with a list of bad variables before anything else starts.
const config = loadConfig();

const db = createDb(config.DATABASE_URL);
// Exits if DATABASE_URL is a superuser or the tables' owner: privileges must bind the app.
await assertAppRole(db).catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
const redis = createRedis(config.REDIS_URL);
const subscriber = createSubscriber(config.REDIS_URL);

let draining = false;

const { app, bus } = buildApp({
  draining: () => draining,
  db,
  redis,
  subscriber,
  logger: { level: config.LOG_LEVEL },
  trustProxy: config.TRUST_PROXY,
  maxStreamsPerOrg: config.MAX_STREAMS_PER_ORG,
  webhookKey: parseSecretKey(config.WEBHOOK_SECRET_KEY),
  exportDir: config.EXPORT_DIR,
  webhookPolicy: { requireHttps: config.NODE_ENV === "production", allowPrivate: config.WEBHOOK_ALLOW_PRIVATE_TARGETS },
});

// Connection errors are reported by /readyz; log them here instead of crashing.
db.on("error", (err) => app.log.error({ err }, "postgres pool error"));
// ioredis emits an error on every reconnect attempt; log once per outage per connection.
for (const [name, client] of [["redis", redis], ["redis subscriber", subscriber]] as const) {
  let down = false;
  client.on("error", (err) => {
    if (!down) app.log.warn({ err: err.message }, `${name} unavailable, retrying in the background`);
    down = true;
  });
  client.on("ready", () => {
    if (down) app.log.info(`${name} reconnected`);
    down = false;
  });
}

app.addHook("onClose", async () => {
  await db.end();
  // quit() waits for pending replies; fall back to a hard disconnect if Redis is down.
  await Promise.all([subscriber.quit().catch(() => subscriber.disconnect()), redis.quit().catch(() => redis.disconnect())]);
});

if (config.SIMULATOR === "on") {
  const simulator = startSimulator(db, bus, app.log);
  // Stop writing (and wait for an in-flight tick) before the pool is closed in onClose.
  app.addHook("preClose", () => simulator.stop());
}

// 1. /readyz says "draining"; 2. after SHUTDOWN_DRAIN_MS, stop accepting connections and
// let in-flight requests finish (event streams are ended by their preClose hook);
// 3. the simulator stops, then Postgres and Redis close (onClose).
handleShutdown({
  log: app.log,
  graceMs: config.SHUTDOWN_GRACE_MS,
  stop: async () => {
    draining = true;
    if (config.SHUTDOWN_DRAIN_MS > 0) await sleep(config.SHUTDOWN_DRAIN_MS);
    await app.close();
  },
});

try {
  await app.listen({ port: config.PORT, host: config.HOST });
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
