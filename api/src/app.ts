import type Database from "better-sqlite3";
import Fastify, { type FastifyServerOptions } from "fastify";
import { createAuthContext, requireOrgMember } from "./auth/context.js";
import type { Clock } from "./auth/sessions.js";
import { EventBus } from "./events.js";
import { authRoutes } from "./routes/auth.js";
import { balancesRoutes } from "./routes/balances.js";
import { eventsRoutes } from "./routes/events.js";
import { transactionsRoutes } from "./routes/transactions.js";

type Options = {
  db: Database.Database;
  clock?: Clock;
  logger?: FastifyServerOptions["logger"];
};

/** Builds the app without listening, so tests can use app.inject(). */
export function buildApp({ db, clock = Date.now, logger = false }: Options) {
  const app = Fastify({
    logger,
    // Only the BFF on this machine may set X-Forwarded-For (it forwards the browser's IP
    // for rate limiting). From anywhere else the header is ignored.
    trustProxy: process.env.TRUST_PROXY ?? "loopback",
  });
  app.decorateRequest("orgAuth", null);

  const bus = new EventBus();
  const auth = createAuthContext(db, clock);

  authRoutes(app, auth);

  // Every /orgs/:orgId/* route lives in this scope, behind the session + membership check.
  void app.register(async (orgScope) => {
    orgScope.addHook("onRequest", requireOrgMember(auth));
    transactionsRoutes(orgScope, db);
    balancesRoutes(orgScope, db);
    eventsRoutes(orgScope, db, bus, auth);
  });

  return { app, bus, auth };
}
