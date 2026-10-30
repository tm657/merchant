import type Database from "better-sqlite3";
import type { FastifyInstance } from "fastify";
import { can } from "../auth/permissions.js";
import type { Currency } from "../db.js";
import { badRequest, orgExists, orgParams } from "./common.js";

export function balancesRoutes(app: FastifyInstance, db: Database.Database) {
  app.get("/orgs/:orgId/balances", (req, reply) => {
    const params = orgParams.safeParse(req.params);
    if (!params.success) return badRequest(reply, params.error);
    const { orgId } = params.data;
    if (!orgExists(db, orgId)) return reply.code(404).send({ error: "org_not_found" });
    // Membership was checked by requireOrgMember; this is the per-role check.
    if (!req.orgAuth || !can(req.orgAuth.role, "balances:read")) {
      return reply.code(403).send({ error: "forbidden" });
    }

    const balances = db
      .prepare<[string], { currency: Currency; available: number }>(
        "SELECT currency, available FROM balances WHERE org_id = ? ORDER BY currency",
      )
      .all(orgId);
    return { balances };
  });
}
