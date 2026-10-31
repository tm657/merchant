import { apiTransactionsQuerySchema as querySchema } from "@mini-payments/shared";
import type { FastifyInstance } from "fastify";
import type { Db } from "../db.js";
import { CursorError, queryTransactionsPage } from "../transactionsQuery.js";
import { badRequest, orgExists, orgParams } from "./common.js";

export function transactionsRoutes(app: FastifyInstance, db: Db) {
  app.get("/orgs/:orgId/transactions", async (req, reply) => {
    const params = orgParams.safeParse(req.params);
    if (!params.success) return badRequest(reply, params.error);
    const { orgId } = params.data;
    if (!(await orgExists(db, orgId))) return reply.code(404).send({ error: "org_not_found" });

    const parsed = querySchema.safeParse(req.query);
    if (!parsed.success) return badRequest(reply, parsed.error);
    const { cursor, limit, ...filters } = parsed.data;

    try {
      return await queryTransactionsPage(db, orgId, filters, cursor, limit);
    } catch (err) {
      if (err instanceof CursorError) return reply.code(400).send({ error: err.code });
      throw err;
    }
  });
}
