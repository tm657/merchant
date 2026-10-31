import { can, type Permission } from "@mini-payments/shared";
import type { FastifyReply, FastifyRequest } from "fastify";
import { requestContext } from "../audit.js";
import type { OrgAuth } from "../auth/context.js";

/** The org member if their role has `permission`; otherwise the reply has been sent. */
export function authorize(req: FastifyRequest, reply: FastifyReply, permission: Permission): OrgAuth | null {
  // requireOrgMember already ran; this is the per-role check.
  if (!req.orgAuth) {
    void reply.code(401).send({ error: "unauthenticated" });
    return null;
  }
  if (!can(req.orgAuth.role, permission)) {
    void reply.code(403).send({ error: "forbidden" });
    return null;
  }
  return req.orgAuth;
}

/** Audit context for the signed-in caller. */
export function userContext(req: FastifyRequest, auth: OrgAuth) {
  return { ...requestContext(req, auth.userId), actorId: auth.userId };
}
