import type Database from "better-sqlite3";
import Fastify, { LogController, type FastifyServerOptions } from "fastify";
import { createAuthContext, requireOrgMember } from "./auth/context.js";
import type { Clock } from "./auth/sessions.js";
import { EventBus } from "./events.js";
import { healthRoutes, type ReadinessCheck } from "./health.js";
import { genReqId, requestIdHeader } from "./requestId.js";
import { authRoutes } from "./routes/auth.js";
import { balancesRoutes } from "./routes/balances.js";
import { eventsRoutes } from "./routes/events.js";
import { transactionsRoutes } from "./routes/transactions.js";

type Options = {
  db: Database.Database;
  clock?: Clock;
  logger?: FastifyServerOptions["logger"];
  /** Dependencies /readyz checks, by name. SQLite is always included. */
  readiness?: Record<string, ReadinessCheck>;
  trustProxy?: string;
  maxStreamsPerOrg?: number;
};

/** Builds the app without listening, so tests can use app.inject(). */
export function buildApp({
  db,
  clock = Date.now,
  logger = false,
  readiness = {},
  // Only the BFF on this machine may set X-Forwarded-For (it forwards the browser's IP
  // for rate limiting). From anywhere else the header is ignored.
  trustProxy = "loopback",
  maxStreamsPerOrg = 20,
}: Options) {
  const app = Fastify({
    logger,
    trustProxy,
    genReqId,
    logController: new LogController({
      // Logged on every request-scoped line, under the same name the BFF uses.
      requestIdLogLabel: "requestId",
      // Probes hit these every few seconds; logging each one buries real traffic.
      disableRequestLogging: (req) => req.url === "/healthz" || req.url === "/readyz",
    }),
  });
  app.decorateRequest("orgAuth", null);
  requestIdHeader(app);

  const bus = new EventBus();
  const auth = createAuthContext(db, clock);

  healthRoutes(app, {
    sqlite: async () => db.prepare("SELECT 1").get(),
    ...readiness,
  });
  authRoutes(app, auth);

  // Every /orgs/:orgId/* route lives in this scope, behind the session + membership check.
  void app.register(async (orgScope) => {
    orgScope.addHook("onRequest", requireOrgMember(auth));
    transactionsRoutes(orgScope, db);
    balancesRoutes(orgScope, db);
    eventsRoutes(orgScope, db, bus, auth, { maxStreamsPerOrg });
  });

  return { app, bus, auth };
}
