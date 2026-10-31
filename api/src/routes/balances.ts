import { can, type Currency } from "@mini-payments/shared";
import type { FastifyInstance } from "fastify";
import type { Db } from "../db.js";
import { badRequest, orgExists, orgParams } from "./common.js";

export function balancesRoutes(app: FastifyInstance, db: Db) {
  app.get("/orgs/:orgId/balances", async (req, reply) => {
    const params = orgParams.safeParse(req.params);
    if (!params.success) return badRequest(reply, params.error);
    const { orgId } = params.data;
    if (!(await orgExists(db, orgId))) return reply.code(404).send({ error: "org_not_found" });
    // Membership was checked by requireOrgMember; this is the per-role check.
    if (!req.orgAuth || !can(req.orgAuth.role, "balances:read")) {
      return reply.code(403).send({ error: "forbidden" });
    }

    const { rows: balances } = await db.query<{ currency: Currency; available: number; reserved: number }>(
      `SELECT currency, available, reserved FROM balances WHERE org_id = $1 ORDER BY currency COLLATE "C"`,
      [orgId],
    );
    return { balances };
  });
}
