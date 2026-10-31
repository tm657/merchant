import type { Role } from "@mini-payments/shared";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { Redis } from "ioredis";
import type { Db } from "../db.js";
import { orgParams } from "../routes/common.js";
import { createLimiters, type Limiters } from "./rateLimit.js";
import { createSessionStore, type Clock, type SessionStore } from "./sessions.js";

export type OrgAuth = { userId: string; orgId: string; role: Role; token: string };

declare module "fastify" {
  interface FastifyRequest {
    /** Set by requireOrgMember on /orgs/:orgId/* routes. */
    orgAuth: OrgAuth | null;
  }
}

export type AuthContext = {
  db: Db;
  sessions: SessionStore;
  limiters: Limiters;
  clock: Clock;
  roleIn(userId: string, orgId: string): Promise<Role | null>;
};

export function createAuthContext(db: Db, redis: Redis, clock: Clock = Date.now, keyPrefix = ""): AuthContext {
  return {
    db,
    clock,
    sessions: createSessionStore(db, clock),
    limiters: createLimiters(redis, clock, keyPrefix),
    roleIn: async (userId, orgId) => {
      const { rows } = await db.query<{ role: Role }>(
        "SELECT role FROM memberships WHERE user_id = $1 AND org_id = $2",
        [userId, orgId],
      );
      return rows[0]?.role ?? null;
    },
  };
}

export function bearerToken(req: FastifyRequest): string | null {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) return null;
  return header.slice("Bearer ".length).trim() || null;
}

/**
 * onRequest hook for every /orgs/:orgId/* route.
 * 401: no valid session. 403: valid session but no membership (also for unknown orgs,
 * so the response doesn't reveal which orgs exist).
 */
export function requireOrgMember(auth: AuthContext) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    const token = bearerToken(req);
    const session = await auth.sessions.validate(token);
    if (!session || !token) return reply.code(401).send({ error: "unauthenticated" });

    const params = orgParams.safeParse(req.params);
    if (!params.success) return reply.code(403).send({ error: "forbidden" });

    const role = await auth.roleIn(session.userId, params.data.orgId);
    if (!role) return reply.code(403).send({ error: "forbidden" });

    req.orgAuth = { userId: session.userId, orgId: params.data.orgId, role, token };
  };
}
