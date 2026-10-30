import type Database from "better-sqlite3";
import type { FastifyReply } from "fastify";
import { z } from "zod";

export const orgParams = z.object({ orgId: z.string().min(1).max(64) });

export function orgExists(db: Database.Database, orgId: string): boolean {
  return db.prepare("SELECT 1 FROM orgs WHERE id = ?").get(orgId) !== undefined;
}

export function badRequest(reply: FastifyReply, error: z.ZodError) {
  return reply.code(400).send({
    error: "invalid_request",
    issues: error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
  });
}
