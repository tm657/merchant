import type { FastifyBaseLogger } from "fastify";

/**
 * Graceful shutdown for a process. On the first SIGTERM or SIGINT, `stop` runs: stop
 * taking new work, finish what's in flight, close Postgres and Redis. Then the process
 * exits 0. If that takes longer than `graceMs` it exits 1, and so does a second signal
 * (an impatient Ctrl+C), so a stuck dependency can never keep a process alive.
 * Unfinished jobs are safe either way: their leases expire and another worker retries them.
 */
export function handleShutdown({
  log,
  graceMs,
  stop,
  exit = (code: number) => process.exit(code),
}: {
  log: FastifyBaseLogger;
  graceMs: number;
  stop: () => Promise<void>;
  exit?: (code: number) => void;
}) {
  let stopping = false;
  const onSignal = (signal: NodeJS.Signals) => {
    if (stopping) {
      log.warn({ signal }, "second signal: exiting now");
      exit(1);
      return;
    }
    stopping = true;
    log.info({ signal, graceMs }, "shutting down: finishing in-flight work");
    const timer = setTimeout(() => {
      log.error({ graceMs }, "shutdown took too long: exiting now");
      exit(1);
    }, graceMs);
    timer.unref();
    stop().then(
      () => {
        clearTimeout(timer);
        log.info("shutdown complete");
        exit(0);
      },
      (err: unknown) => {
        clearTimeout(timer);
        log.error({ err }, "shutdown failed");
        exit(1);
      },
    );
  };
  process.on("SIGTERM", onSignal);
  process.on("SIGINT", onSignal);
  /** Removes the handlers (for tests). */
  return () => {
    process.off("SIGTERM", onSignal);
    process.off("SIGINT", onSignal);
  };
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Like sleep, but returns at once when `signal` aborts (so idle loops stop promptly). */
export function sleepUnless(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const t = setTimeout(done, ms);
    function done() {
      clearTimeout(t);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });
}

/** Closes a Redis client cleanly (waits for pending replies), or hard if Redis is down. */
export async function closeRedis(client: { quit(): Promise<unknown>; disconnect(): void }): Promise<void> {
  await client.quit().catch(() => client.disconnect());
}
