import { z } from "zod";

/** Every action the audit log records. */
export const AUDIT_ACTIONS = [
  "auth.login.succeeded",
  "auth.login.failed",
  "auth.logout",
  "payout.created",
  "payout.approved",
  "payout.rejected",
  "payout.cancelled",
  "payout.processing",
  "payout.paid",
  "payout.failed",
  "webhook.endpoint.created",
  "webhook.endpoint.updated",
  "webhook.endpoint.secret_rotated",
  "webhook.endpoint.deleted",
  "webhook.delivery.redelivered",
  "audit.exported",
] as const;
export type AuditAction = (typeof AUDIT_ACTIONS)[number];

/** Filter value for entries made by the system (the workers) rather than a person. */
export const SYSTEM_ACTOR = "system";

export const auditEntrySchema = z.object({
  id: z.number().int(),
  orgId: z.string().nullable(),
  /** null: the system or an unknown caller (e.g. a failed login for an unknown email). */
  actorId: z.string().nullable(),
  actorLabel: z.string(),
  action: z.enum(AUDIT_ACTIONS),
  targetType: z.string().nullable(),
  targetId: z.string().nullable(),
  metadata: z.record(z.string(), z.unknown()),
  ip: z.string().nullable(),
  userAgent: z.string().nullable(),
  requestId: z.string().nullable(),
  createdAt: z.iso.datetime(),
});
export type AuditEntry = z.infer<typeof auditEntrySchema>;

export const auditPageSchema = z.object({ items: z.array(auditEntrySchema), nextCursor: z.string().nullable() });
export type AuditPage = z.infer<typeof auditPageSchema>;

const filterFields = {
  /** A user id, or SYSTEM_ACTOR. */
  actor: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/).optional(),
  action: z.enum(AUDIT_ACTIONS).optional(),
  from: z.iso.date().optional(), // YYYY-MM-DD, inclusive (UTC)
  to: z.iso.date().optional(), // YYYY-MM-DD, inclusive (UTC)
};
const validRange = (v: { from?: string; to?: string }) => !v.from || !v.to || v.from <= v.to;
const rangeError = { message: "from must be on or before to", path: ["from"] };

/** Filters shared by the list and the CSV export. */
export const auditFiltersSchema = z.object(filterFields).strict().refine(validRange, rangeError);
export type AuditFilters = z.infer<typeof auditFiltersSchema>;

/** BFF input: only set values are forwarded. */
export const auditQuerySchema = z
  .object({
    ...filterFields,
    cursor: z.string().min(1).max(500).optional(),
    limit: z.coerce.number().int().min(1).max(100).optional(),
  })
  .strict()
  .refine(validRange, rangeError);
export const apiAuditQuerySchema = z
  .object({
    ...filterFields,
    cursor: z.string().min(1).max(500).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
  })
  .strict()
  .refine(validRange, rangeError);

/** The export is capped so one request can't pull the whole log. */
export const AUDIT_EXPORT_MAX_ROWS = 10_000;

/** Org members, for the audit log's actor filter (admins only). */
export const orgMembersSchema = z.object({
  items: z.array(z.object({ id: z.string(), name: z.string(), email: z.string(), role: z.string() })),
});
export type OrgMembers = z.infer<typeof orgMembersSchema>;
