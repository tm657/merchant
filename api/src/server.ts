import { buildApp } from "./app.js";
import { openDb } from "./db.js";
import { startSimulator } from "./simulator.js";

const PORT = Number(process.env.PORT ?? 4000);
const HOST = process.env.HOST ?? "127.0.0.1";

const db = openDb();
const { app, bus } = buildApp({ db, logger: true });

app.addHook("onClose", () => db.close());

// Set SIMULATOR=off to disable live transactions.
if (process.env.SIMULATOR !== "off") {
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
  await app.listen({ port: PORT, host: HOST });
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
