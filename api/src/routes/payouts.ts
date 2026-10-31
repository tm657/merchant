import {
  apiPayoutsQuerySchema,
  approvePayoutBodySchema,
  cancelPayoutBodySchema,
  createPayoutBodySchema,
  IDEMPOTENCY_KEY_HEADER,
  IDEMPOTENT_REPLAYED_HEADER,
  idempotencyKeySchema,
  payoutIdSchema,
  rejectPayoutBodySchema,
} from "@mini-payments/shared";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { OrgAuth } from "../auth/context.js";
import { RateLimiterUnavailableError, type AttemptLimiter } from "../auth/rateLimit.js";
import { PayoutError, type PayoutService } from "../payouts/service.js";
import { badRequest, unavailable } from "./common.js";
import { authorize, userContext } from "./orgAuth.js";

const payoutParams = z.object({ orgId: z.string(), payoutId: payoutIdSchema });

/** Turns service refusals into their status codes; anything else stays a 500. */
async function handle(req: FastifyRequest, reply: FastifyReply, fn: () => Promise<unknown>) {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof PayoutError) return reply.code(err.status).send({ error: err.code });
    if (err instanceof RateLimiterUnavailableError) {
      req.log.error({ err: err.cause }, "rate limiter unavailable, refusing request");
      return unavailable(reply);
    }
    throw err;
  }
}

export function payoutsRoutes(app: FastifyInstance, service: PayoutService, createLimiter: AttemptLimiter) {
  app.get("/orgs/:orgId/payouts", async (req, reply) => {
    const auth = authorize(req, reply, "payout:read");
    if (!auth) return reply;
    const query = apiPayoutsQuerySchema.safeParse(req.query);
    if (!query.success) return badRequest(reply, query.error);
    return handle(req, reply, () => service.list(auth.orgId, query.data));
  });

  app.get("/orgs/:orgId/payouts/:payoutId", async (req, reply) => {
    const auth = authorize(req, reply, "payout:read");
    if (!auth) return reply;
    const params = payoutParams.safeParse(req.params);
    if (!params.success) return reply.code(404).send({ error: "payout_not_found" });
    return handle(req, reply, () => service.get(auth.orgId, params.data.payoutId));
  });

  app.post("/orgs/:orgId/payouts", async (req, reply) => {
    const auth = authorize(req, reply, "payout:create");
    if (!auth) return reply;
    const key = idempotencyKeySchema.safeParse(req.headers[IDEMPOTENCY_KEY_HEADER]);
    if (!key.success) return reply.code(400).send({ error: "idempotency_key_required" });
    const body = createPayoutBodySchema.safeParse(req.body);
    if (!body.success) return badRequest(reply, body.error);

    return handle(req, reply, async () => {
      const userKey = `user:${auth.userId}`;
      // A known key can only replay or 422, so it skips the limit: retries must always work.
      const wait = (await service.keyExists(auth.orgId, key.data)) ? 0 : await createLimiter.retryAfterMs(userKey);
      if (wait > 0) {
        return reply
          .code(429)
          .header("retry-after", String(Math.ceil(wait / 1000)))
          .send({ error: "too_many_requests" });
      }
      const result = await service.create(auth.orgId, userContext(req, auth), key.data, body.data);
      // Replays don't count: retrying a request you already made must stay possible.
      if (!result.replayed) await createLimiter.hit(userKey);
      if (result.replayed) void reply.header(IDEMPOTENT_REPLAYED_HEADER, "true");
      return reply.code(result.status).send(result.body);
    });
  });

  /** POST /orgs/:orgId/payouts/:payoutId/<action>: parse params and body, then decide. */
  function decision<S extends z.ZodType>(
    action: string,
    permission: Parameters<typeof authorize>[2],
    schema: S,
    decide: (auth: OrgAuth, ctx: ReturnType<typeof userContext>, payoutId: string, body: z.infer<S>) => Promise<unknown>,
  ) {
    app.post(`/orgs/:orgId/payouts/:payoutId/${action}`, async (req, reply) => {
      const auth = authorize(req, reply, permission);
      if (!auth) return reply;
      const params = payoutParams.safeParse(req.params);
      if (!params.success) return reply.code(404).send({ error: "payout_not_found" });
      const body = schema.safeParse(req.body);
      if (!body.success) return badRequest(reply, body.error);
      return handle(req, reply, async () => ({
        payout: await decide(auth, userContext(req, auth), params.data.payoutId, body.data),
      }));
    });
  }

  decision("approve", "payout:approve", approvePayoutBodySchema, (a, ctx, id, b) =>
    service.approve(a.orgId, ctx, id, b.version),
  );
  decision("reject", "payout:reject", rejectPayoutBodySchema, (a, ctx, id, b) =>
    service.reject(a.orgId, ctx, id, b.version, b.reason),
  );
  // Cancelling is the creator's call; the service checks it's really theirs.
  decision("cancel", "payout:create", cancelPayoutBodySchema, (a, ctx, id, b) => service.cancel(a.orgId, ctx, id, b.version));
}
