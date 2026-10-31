import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { assertAppRole, createDb } from "./db.js";
import { createRedis, createSubscriber } from "./redis.js";
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

const { app, bus } = buildApp({
  db,
  redis,
  subscriber,
  logger: { level: config.LOG_LEVEL },
  trustProxy: config.TRUST_PROXY,
  maxStreamsPerOrg: config.MAX_STREAMS_PER_ORG,
  webhookKey: parseSecretKey(config.WEBHOOK_SECRET_KEY),
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
  subscriber.disconnect();
  redis.disconnect();
});

if (config.SIMULATOR === "on") {
  const simulator = startSimulator(db, bus, app.log);
  // Stop writing (and wait for an in-flight tick) before the pool is closed in onClose.
  app.addHook("preClose", () => simulator.stop());
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => void app.close().then(() => process.exit(0)));
}

try {
  await app.listen({ port: config.PORT, host: config.HOST });
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
