import type { FastifyError, FastifyInstance } from "fastify";

/** The largest request body the API accepts. Every real one is well under 4 KB. */
export const BODY_LIMIT_BYTES = 16 * 1024;

/**
 * Headers for every API response. The API only talks to the BFF, never renders pages,
 * so nothing may load, frame or sniff what it returns. There is deliberately no CORS
 * support: no Access-Control-* header is ever sent, so browsers on other origins can't
 * read responses (and the API listens on 127.0.0.1 anyway).
 */
export const SECURITY_HEADERS: Record<string, string> = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "content-security-policy": "default-src 'none'; frame-ancestors 'none'",
  "x-frame-options": "DENY",
};

export function securityHeaders(app: FastifyInstance) {
  app.addHook("onRequest", async (_req, reply) => {
    reply.headers(SECURITY_HEADERS);
  });
}

/**
 * Errors in the API's own { error: code } shape. Body-parser refusals get stable codes;
 * 5xx answers never carry internal messages (they go to the log, with the request id).
 * Errors the routes produce themselves are sent by the routes and never reach this.
 */
export function errorHandler(app: FastifyInstance) {
  app.setErrorHandler((err: FastifyError, req, reply) => {
    const status = err.statusCode && err.statusCode >= 400 ? err.statusCode : 500;
    if (err.code === "FST_ERR_CTP_BODY_TOO_LARGE") return reply.code(413).send({ error: "payload_too_large" });
    if (err.code === "FST_ERR_CTP_INVALID_MEDIA_TYPE") return reply.code(415).send({ error: "unsupported_media_type" });
    if (err.code?.startsWith("FST_ERR_CTP_") || (status === 400 && err instanceof SyntaxError)) {
      return reply.code(400).send({ error: "invalid_json" });
    }
    if (status >= 500) {
      req.log.error({ err }, "request failed");
      return reply.code(500).send({ error: "internal_error" });
    }
    return reply.code(status).send({ error: err.code?.toLowerCase() ?? "bad_request" });
  });
}
