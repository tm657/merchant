import type { FastifyReply } from "fastify";
import type { z } from "zod";
import type { Queryable } from "../db.js";

export { orgParamsSchema as orgParams } from "@mini-payments/shared";

export async function orgExists(db: Queryable, orgId: string): Promise<boolean> {
  const { rowCount } = await db.query("SELECT 1 FROM orgs WHERE id = $1", [orgId]);
  return (rowCount ?? 0) > 0;
}

export function badRequest(reply: FastifyReply, error: z.ZodError) {
  return reply.code(400).send({
    error: "invalid_request",
    issues: error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
  });
}

/** Fail closed when a dependency the request needs (e.g. the Redis rate limiter) is down. */
export function unavailable(reply: FastifyReply) {
  return reply.code(503).header("retry-after", "5").send({ error: "service_unavailable" });
}
