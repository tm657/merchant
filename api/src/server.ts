import Fastify from "fastify";
import { openDb } from "./db.js";
import { balancesRoutes } from "./routes/balances.js";
import { transactionsRoutes } from "./routes/transactions.js";

const PORT = Number(process.env.PORT ?? 4000);
const HOST = process.env.HOST ?? "127.0.0.1";

const db = openDb();
const app = Fastify({ logger: true });

app.addHook("onClose", () => db.close());
transactionsRoutes(app, db);
balancesRoutes(app, db);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => void app.close().then(() => process.exit(0)));
}

try {
  await app.listen({ port: PORT, host: HOST });
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
