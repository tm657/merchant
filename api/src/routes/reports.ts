import { exportFiltersSchema, exportIdSchema, settlementsQuerySchema } from "@mini-payments/shared";
import type { FastifyInstance, FastifyReply } from "fastify";
import { createReadStream } from "node:fs";
import { z } from "zod";
import type { Db } from "../db.js";
import { ExportError, type ExportService } from "../exports/service.js";
import { listSettlements } from "../settlements.js";
import { badRequest } from "./common.js";
import { authorize, userContext } from "./orgAuth.js";

const exportParams = z.object({ orgId: z.string(), exportId: exportIdSchema });

async function handle(reply: FastifyReply, fn: () => Promise<unknown>) {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof ExportError) return reply.code(err.status).send({ error: err.code });
    throw err;
  }
}

/** Exports and settlements: reports:export (admin, finance) on every route. */
export function reportsRoutes(app: FastifyInstance, exports: ExportService, db: Db) {
  app.post("/orgs/:orgId/exports", async (req, reply) => {
    const auth = authorize(req, reply, "reports:export");
    if (!auth) return reply;
    const filters = exportFiltersSchema.safeParse(req.body ?? {});
    if (!filters.success) return badRequest(reply, filters.error);
    return handle(reply, async () => reply.code(202).send({ export: await exports.create(auth.orgId, userContext(req, auth), filters.data) }));
  });

  app.get("/orgs/:orgId/exports", async (req, reply) => {
    const auth = authorize(req, reply, "reports:export");
    if (!auth) return reply;
    return { items: await exports.list(auth.orgId) };
  });

  app.get("/orgs/:orgId/exports/:exportId", async (req, reply) => {
    const auth = authorize(req, reply, "reports:export");
    if (!auth) return reply;
    const params = exportParams.safeParse(req.params);
    if (!params.success) return reply.code(404).send({ error: "export_not_found" });
    return handle(reply, async () => ({ export: await exports.get(auth.orgId, params.data.exportId) }));
  });

  // Authorised on every request (session, membership, role, org, expiry), never by URL alone.
  app.get("/orgs/:orgId/exports/:exportId/download", async (req, reply) => {
    const auth = authorize(req, reply, "reports:export");
    if (!auth) return reply;
    const params = exportParams.safeParse(req.params);
    if (!params.success) return reply.code(404).send({ error: "export_not_found" });
    return handle(reply, async () => {
      const file = await exports.openDownload(auth.orgId, userContext(req, auth), params.data.exportId);
      return reply
        .header("content-type", "text/csv; charset=utf-8")
        .header("content-disposition", `attachment; filename="${file.name}"`)
        .header("content-length", String(file.size))
        .header("cache-control", "private, no-store")
        .header("x-content-type-options", "nosniff")
        .send(createReadStream(file.path));
    });
  });

  app.get("/orgs/:orgId/settlements", async (req, reply) => {
    const auth = authorize(req, reply, "reports:export");
    if (!auth) return reply;
    const query = settlementsQuerySchema.safeParse(req.query);
    if (!query.success) return badRequest(reply, query.error);
    return listSettlements(db, auth.orgId, query.data.from, query.data.to);
  });
}
