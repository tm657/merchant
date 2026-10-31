import { apiAuditQuerySchema, auditFiltersSchema } from "@mini-payments/shared";
import type { FastifyInstance } from "fastify";
import { AuditQueryError, type AuditLog } from "../auditLog.js";
import type { Queryable } from "../db.js";
import { badRequest } from "./common.js";
import { authorize, userContext } from "./orgAuth.js";

export function auditRoutes(app: FastifyInstance, log: AuditLog, db: Queryable) {
  app.get("/orgs/:orgId/audit", async (req, reply) => {
    const auth = authorize(req, reply, "audit:read");
    if (!auth) return reply;
    const query = apiAuditQuerySchema.safeParse(req.query);
    if (!query.success) return badRequest(reply, query.error);
    try {
      return await log.list(auth.orgId, query.data);
    } catch (err) {
      if (err instanceof AuditQueryError) return reply.code(400).send({ error: err.code });
      throw err;
    }
  });

  app.get("/orgs/:orgId/members", async (req, reply) => {
    const auth = authorize(req, reply, "audit:read");
    if (!auth) return reply;
    const { rows } = await db.query<{ id: string; name: string; email: string; role: string }>(
      `SELECT u.id, u.name, u.email, m.role FROM memberships m JOIN users u ON u.id = m.user_id
       WHERE m.org_id = $1 ORDER BY u.name, u.id`,
      [auth.orgId],
    );
    return { items: rows };
  });

  // POST: an export is an action (it's audited), not a plain read.
  app.post("/orgs/:orgId/audit/export", async (req, reply) => {
    const auth = authorize(req, reply, "audit:export");
    if (!auth) return reply;
    const filters = auditFiltersSchema.safeParse(req.body ?? {});
    if (!filters.success) return badRequest(reply, filters.error);
    const { csv, rows, truncated } = await log.exportCsv(auth.orgId, userContext(req, auth), filters.data);
    const date = new Date().toISOString().slice(0, 10);
    return reply
      .header("content-type", "text/csv; charset=utf-8")
      .header("content-disposition", `attachment; filename="audit-${auth.orgId}-${date}.csv"`)
      .header("x-export-rows", String(rows))
      .header("x-export-truncated", String(truncated))
      .send(csv);
  });
}
