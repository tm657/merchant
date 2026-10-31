import { REQUEST_ID_HEADER, requestIdSchema } from "@mini-payments/shared";
import type { FastifyInstance } from "fastify";
import type { IncomingMessage } from "node:http";
import { randomUUID } from "node:crypto";

/**
 * Fastify genReqId: reuse the BFF's x-request-id when it's well formed, so one ID
 * follows a request across both services. Otherwise make a new one.
 * Fastify puts this ID on every log line written through req.log as "reqId".
 */
export function genReqId(req: IncomingMessage): string {
  const incoming = req.headers[REQUEST_ID_HEADER];
  const parsed = requestIdSchema.safeParse(Array.isArray(incoming) ? incoming[0] : incoming);
  return parsed.success ? parsed.data : randomUUID();
}

/** Echoes the ID back so callers can quote it when reporting a problem. */
export function requestIdHeader(app: FastifyInstance) {
  app.addHook("onRequest", async (req, reply) => {
    reply.header(REQUEST_ID_HEADER, req.id);
  });
}
