import type { FastifyInstance } from "fastify";

/** A readiness probe: resolves if the dependency is usable, rejects otherwise. */
export type ReadinessCheck = () => Promise<unknown>;

const CHECK_TIMEOUT_MS = 2000;

function withTimeout(check: ReadinessCheck, ms: number): Promise<unknown> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${ms} ms`)), ms);
  });
  return Promise.race([check(), timeout]).finally(() => clearTimeout(timer));
}

/**
 * /healthz: the process is up (liveness). Never touches dependencies, so a database
 * outage doesn't get the process restarted.
 * /readyz: every dependency answers (readiness). 503 until they all do.
 */
export function healthRoutes(app: FastifyInstance, checks: Record<string, ReadinessCheck>, draining: () => boolean = () => false) {
  app.get("/healthz", async () => ({ status: "ok" }));

  app.get("/readyz", async (req, reply) => {
    // Shutting down: tell load balancers to stop sending traffic, before anything closes.
    if (draining()) return reply.code(503).send({ status: "draining", checks: {} });
    const entries = await Promise.all(
      Object.entries(checks).map(async ([name, check]) => {
        try {
          await withTimeout(check, CHECK_TIMEOUT_MS);
          return [name, "ok"] as const;
        } catch (err) {
          req.log.warn({ check: name, err }, "readiness check failed");
          return [name, "error"] as const;
        }
      }),
    );
    const ready = entries.every(([, status]) => status === "ok");
    // Only up/down per check: error details stay in the logs.
    return reply.code(ready ? 200 : 503).send({ status: ready ? "ok" : "unavailable", checks: Object.fromEntries(entries) });
  });
}
