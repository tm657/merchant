import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { openDb } from "./db.js";
import { createPgPool } from "./pg.js";
import { createRedis } from "./redis.js";
import { startSimulator } from "./simulator.js";

// Exits with a list of bad variables before anything else starts.
const config = loadConfig();

const db = openDb(config.DB_PATH);
const pg = createPgPool(config.DATABASE_URL);
const redis = createRedis(config.REDIS_URL);

const { app, bus } = buildApp({
  db,
  logger: { level: config.LOG_LEVEL },
  trustProxy: config.TRUST_PROXY,
  maxStreamsPerOrg: config.MAX_STREAMS_PER_ORG,
  readiness: {
    postgres: () => pg.query("SELECT 1"),
    redis: () => redis.ping(),
  },
});

// Connection errors are reported by /readyz; log them here instead of crashing.
pg.on("error", (err) => app.log.error({ err }, "postgres pool error"));
// ioredis emits an error on every reconnect attempt; log once per outage.
let redisDown = false;
redis.on("error", (err) => {
  if (!redisDown) app.log.warn({ err: err.message }, "redis unavailable, retrying in the background");
  redisDown = true;
});
redis.on("ready", () => {
  if (redisDown) app.log.info("redis reconnected");
  redisDown = false;
});

app.addHook("onClose", async () => {
  db.close();
  await pg.end();
  redis.disconnect();
});

if (config.SIMULATOR === "on") {
  const simulator = startSimulator(db, bus, app.log);
  // Stop writing before the database is closed in onClose.
  app.addHook("preClose", (done) => {
    simulator.stop();
    done();
  });
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
