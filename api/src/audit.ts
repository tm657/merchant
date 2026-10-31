import type { AuditAction } from "@mini-payments/shared";
import type { FastifyRequest } from "fastify";
import type { Queryable } from "./db.js";

/** Who did something, and from where. */
export type AuditContext = {
  /** null: the system (a worker) or an unknown caller. */
  actorId: string | null;
  /** Used when there's no actorId (e.g. "system"); otherwise the actor's email is looked up. */
  fallbackLabel: string;
  ip: string | null;
  userAgent: string | null;
  requestId: string | null;
};

export const SYSTEM: AuditContext = { actorId: null, fallbackLabel: "system", ip: null, userAgent: null, requestId: null };

/** The request's caller, IP (via trustProxy), user agent and request id. */
export function requestContext(req: FastifyRequest, actorId: string | null): AuditContext {
  return {
    actorId,
    fallbackLabel: actorId ? actorId : "anonymous",
    ip: req.ip || null,
    userAgent: req.headers["user-agent"]?.slice(0, 512) ?? null,
    requestId: req.id,
  };
}

export type AuditEntryInput = {
  orgId: string | null;
  action: AuditAction;
  targetType?: string;
  targetId?: string;
  /** Never put secrets, tokens, passwords or full account numbers in here. */
  metadata?: Record<string, unknown>;
};

/**
 * Appends one audit entry. Always pass the transaction of the action being recorded, so
 * the entry exists if and only if the action committed. The log is append-only: the
 * app's role can't UPDATE or DELETE it, and triggers refuse it for everyone else.
 */
export async function audit(tx: Queryable, ctx: AuditContext, entry: AuditEntryInput, now: string): Promise<void> {
  await tx.query(
    `INSERT INTO audit_log (org_id, actor_id, actor_label, action, target_type, target_id, metadata, ip, user_agent, request_id, created_at)
     VALUES ($1, $2, COALESCE((SELECT email FROM users WHERE id = $2), $3), $4, $5, $6, $7, $8, $9, $10, $11)`,
    [
      entry.orgId,
      ctx.actorId,
      ctx.fallbackLabel,
      entry.action,
      entry.targetType ?? null,
      entry.targetId ?? null,
      JSON.stringify(entry.metadata ?? {}),
      ctx.ip,
      ctx.userAgent,
      ctx.requestId,
      now,
    ],
  );
}
