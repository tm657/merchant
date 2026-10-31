import Fastify, { LogController, type FastifyServerOptions } from "fastify";
import type { Redis } from "ioredis";
import { createAuthContext, requireOrgMember } from "./auth/context.js";
import type { Clock } from "./auth/sessions.js";
import type { Db } from "./db.js";
import { EventBus } from "./events.js";
import { healthRoutes, type ReadinessCheck } from "./health.js";
import { genReqId, requestIdHeader } from "./requestId.js";
import { authRoutes } from "./routes/auth.js";
import { balancesRoutes } from "./routes/balances.js";
import { eventsRoutes } from "./routes/events.js";
import { transactionsRoutes } from "./routes/transactions.js";

type Options = {
  db: Db;
  /** Command connection: rate limits, publishing events, /readyz. */
  redis: Redis;
  /** Dedicated pub/sub connection for receiving events. */
  subscriber: Redis;
  clock?: Clock;
  logger?: FastifyServerOptions["logger"];
  /** Prefix for every Redis key and channel (tests use one per app). */
  redisPrefix?: string;
  /** Extra or replacement /readyz checks, by name (tests use this). */
  readiness?: Record<string, ReadinessCheck>;
  trustProxy?: string;
  maxStreamsPerOrg?: number;
};

/** Builds the app without listening, so tests can use app.inject(). */
export function buildApp({
  db,
  redis,
  subscriber,
  clock = Date.now,
  logger = false,
  redisPrefix = "",
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

  const bus = new EventBus(redis, subscriber, app.log, redisPrefix);
  const auth = createAuthContext(db, redis, clock, redisPrefix);

  healthRoutes(app, {
    postgres: () => db.query("SELECT 1"),
    redis: async () => {
      await redis.ping();
      // Without the subscriber, SSE clients on this instance would miss every event.
      if (subscriber.status !== "ready") throw new Error(`redis subscriber is ${subscriber.status}`);
    },
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
