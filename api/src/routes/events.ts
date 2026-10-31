import type { FastifyInstance } from "fastify";
import type { ServerResponse } from "node:http";
import type { AuthContext } from "../auth/context.js";
import type { Db } from "../db.js";
import { can, REQUEST_ID_HEADER } from "@mini-payments/shared";
import { SECURITY_HEADERS } from "../security.js";
import type { EventBus, OrgEvent } from "../events.js";
import { badRequest, orgExists, orgParams, unavailable } from "./common.js";

const HEARTBEAT_MS = 15_000;
// A client that stops reading gets dropped instead of growing memory without limit.
const MAX_BUFFERED_BYTES = 64 * 1024;

function format(event: OrgEvent): string {
  const data =
    event.type === "balance"
      ? { currency: event.currency, available: event.available, reserved: event.reserved }
      : event.type === "payout"
        ? { payoutId: event.payoutId, status: event.status, version: event.version }
        : event.type === "export"
          ? { exportId: event.exportId, status: event.status, rowsWritten: event.rowsWritten, rowsTotal: event.rowsTotal }
          : { count: event.count };
  return `event: ${event.type}\ndata: ${JSON.stringify(data)}\n\n`;
}

export function eventsRoutes(
  app: FastifyInstance,
  db: Db,
  bus: EventBus,
  auth: AuthContext,
  { maxStreamsPerOrg }: { maxStreamsPerOrg: number },
) {
  const openPerOrg = new Map<string, number>();
  const openStreams = new Set<ServerResponse>();

  // Hijacked responses would keep the server from closing, so end them first.
  app.addHook("preClose", (done) => {
    for (const res of openStreams) res.end();
    done();
  });

  app.get("/orgs/:orgId/events", async (req, reply) => {
    const params = orgParams.safeParse(req.params);
    if (!params.success) return badRequest(reply, params.error);
    const { orgId } = params.data;
    if (!(await orgExists(db, orgId))) return reply.code(404).send({ error: "org_not_found" });
    const orgAuth = req.orgAuth;
    if (!orgAuth) return reply.code(401).send({ error: "unauthenticated" });
    const canSeeBalances = can(orgAuth.role, "balances:read");
    const canSeePayouts = can(orgAuth.role, "payout:read");
    const canSeeExports = can(orgAuth.role, "reports:export");

    const open = openPerOrg.get(orgId) ?? 0;
    if (open >= maxStreamsPerOrg) {
      return reply.code(429).header("retry-after", "10").send({ error: "too_many_streams" });
    }
    openPerOrg.set(orgId, open + 1);

    const res = reply.raw;
    let done = false;
    let unsubscribe = () => {};
    // Started once the stream is open; cleanup can run before that.
    let heartbeat: NodeJS.Timeout | undefined = undefined;
    const cleanup = () => {
      if (done) return;
      done = true;
      clearInterval(heartbeat);
      unsubscribe();
      openStreams.delete(res);
      const left = (openPerOrg.get(orgId) ?? 1) - 1;
      if (left > 0) openPerOrg.set(orgId, left);
      else openPerOrg.delete(orgId);
    };

    const send = (chunk: string) => {
      if (done) return;
      if (res.writableLength > MAX_BUFFERED_BYTES) {
        req.log.warn({ orgId }, "dropping slow SSE client");
        res.destroy();
        return;
      }
      res.write(chunk);
    };

    // Subscribe before sending headers: if Redis is down the client gets a clean 503 and
    // its EventSource retries. Once this resolves, no published event can be missed.
    try {
      unsubscribe = await bus.subscribe(orgId, (event) => {
        if (event.type === "balance" && !canSeeBalances) return;
        if (event.type === "payout" && !canSeePayouts) return;
        if (event.type === "export" && !canSeeExports) return;
        send(format(event));
      });
    } catch (err) {
      cleanup();
      req.log.error({ err, orgId }, "event bus unavailable");
      return unavailable(reply);
    }
    // The client may have gone away while we waited.
    if (req.raw.destroyed) {
      cleanup();
      return;
    }

    // From here on we write to the raw socket ourselves.
    reply.hijack();
    openStreams.add(res);
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
      // Hijacked, so headers set by hooks are not sent; add them by hand.
      ...SECURITY_HEADERS,
      [REQUEST_ID_HEADER]: req.id,
    });
    res.write(": connected\n\n");

    // A stream outlives the request that authorized it, so re-check on every heartbeat:
    // logout, expiry or a removed membership ends the stream within 15 s.
    // touch: false, because an open tab is not user activity for the idle timeout.
    let checking = false;
    heartbeat = setInterval(() => {
      if (checking) return;
      checking = true;
      void (async () => {
        try {
          const session = await auth.sessions.validate(orgAuth.token, { touch: false });
          if (!session || (await auth.roleIn(session.userId, orgId)) !== orgAuth.role) {
            res.end();
            return;
          }
          send(": heartbeat\n\n");
        } catch (err) {
          // Can't confirm the session is still valid, so don't keep streaming.
          req.log.warn({ err, orgId }, "session re-check failed, closing stream");
          res.end();
        } finally {
          checking = false;
        }
      })();
    }, HEARTBEAT_MS);

    // Fires on client disconnect, on res.end() at shutdown, and on destroy().
    res.on("close", cleanup);
  });
}
