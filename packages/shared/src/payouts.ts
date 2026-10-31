import { z } from "zod";
import { CURRENCIES } from "./currency.ts";

// ---- State machine ---------------------------------------------------------

export const PAYOUT_STATUSES = [
  "pending_approval",
  "approved",
  "processing",
  "paid",
  "failed",
  "rejected",
  "cancelled",
] as const;
export type PayoutStatus = (typeof PAYOUT_STATUSES)[number];

/**
 * Every allowed transition. Anything not listed is invalid (the API answers 409).
 *   pending_approval -> approved | rejected | cancelled
 *   approved         -> processing
 *   processing       -> paid | failed
 * paid, failed, rejected and cancelled are terminal.
 */
const TRANSITIONS: Record<PayoutStatus, readonly PayoutStatus[]> = {
  pending_approval: ["approved", "rejected", "cancelled"],
  approved: ["processing"],
  processing: ["paid", "failed"],
  paid: [],
  failed: [],
  rejected: [],
  cancelled: [],
};

export function canTransition(from: PayoutStatus, to: PayoutStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export function isTerminal(status: PayoutStatus): boolean {
  return TRANSITIONS[status].length === 0;
}

// ---- Requests --------------------------------------------------------------

export const IDEMPOTENCY_KEY_HEADER = "idempotency-key";
export const IDEMPOTENT_REPLAYED_HEADER = "idempotent-replayed";
/** A client-generated key, e.g. crypto.randomUUID(). */
export const idempotencyKeySchema = z.string().regex(/^[A-Za-z0-9_-]{8,128}$/, "8–128 letters, digits, - or _");

export const payoutIdSchema = z.string().regex(/^po_[A-Za-z0-9-]{1,64}$/);

export const createPayoutBodySchema = z
  .object({
    /** Integer minor units. Use parseMoneyInput for what a person typed. */
    amount: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    currency: z.enum(CURRENCIES),
    beneficiaryName: z.string().trim().min(1, "Enter the beneficiary's name").max(100),
    accountNumber: z
      .string()
      .transform((s) => s.replace(/[\s-]/g, "").toUpperCase())
      .pipe(z.string().regex(/^[A-Z0-9]{4,34}$/, "Use 4–34 letters or digits")),
    reference: z.string().trim().max(140).default(""),
  })
  .strict();
export type CreatePayoutBody = z.infer<typeof createPayoutBodySchema>;

/** Every decision carries the version the person was looking at (optimistic concurrency). */
const versionSchema = z.number().int().positive();
export const approvePayoutBodySchema = z.object({ version: versionSchema }).strict();
export const cancelPayoutBodySchema = z.object({ version: versionSchema }).strict();
export const rejectPayoutBodySchema = z
  .object({ version: versionSchema, reason: z.string().trim().min(1, "Give a reason").max(500) })
  .strict();

export const PAYOUT_ACTIONS = ["approve", "reject", "cancel"] as const;
export type PayoutAction = (typeof PAYOUT_ACTIONS)[number];

const listFields = {
  status: z.enum(PAYOUT_STATUSES).optional(),
  cursor: z.string().min(1).max(500).optional(),
};
/** BFF input: only set values are forwarded. */
export const payoutsQuerySchema = z
  .object({ ...listFields, limit: z.coerce.number().int().min(1).max(100).optional() })
  .strict();
/** API input, with the default page size. */
export const apiPayoutsQuerySchema = z
  .object({ ...listFields, limit: z.coerce.number().int().min(1).max(100).default(25) })
  .strict();

// ---- Responses -------------------------------------------------------------

const personSchema = z.object({ id: z.string(), name: z.string() });

export const payoutSchema = z.object({
  id: payoutIdSchema,
  amount: z.number().int().positive(),
  currency: z.enum(CURRENCIES),
  status: z.enum(PAYOUT_STATUSES),
  version: versionSchema,
  beneficiaryName: z.string(),
  /** Only the last 4 characters of the account number ever leave the API. */
  accountLast4: z.string(),
  reference: z.string(),
  createdBy: personSchema,
  /** Who approved or rejected it. */
  decidedBy: personSchema.nullable(),
  rejectReason: z.string().nullable(),
  failureReason: z.string().nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type Payout = z.infer<typeof payoutSchema>;

export const payoutTimelineEntrySchema = z.object({
  id: z.number().int(),
  fromStatus: z.enum(PAYOUT_STATUSES).nullable(),
  toStatus: z.enum(PAYOUT_STATUSES),
  /** null: the system (worker). */
  actor: personSchema.nullable(),
  reason: z.string().nullable(),
  at: z.iso.datetime(),
});
export type PayoutTimelineEntry = z.infer<typeof payoutTimelineEntrySchema>;

export const payoutDetailSchema = z.object({ payout: payoutSchema, timeline: z.array(payoutTimelineEntrySchema) });
export type PayoutDetail = z.infer<typeof payoutDetailSchema>;

/** Create, approve, reject and cancel all answer with the pay-out as it is now. */
export const payoutResponseSchema = z.object({ payout: payoutSchema });

export const payoutsPageSchema = z.object({ items: z.array(payoutSchema), nextCursor: z.string().nullable() });
export type PayoutsPage = z.infer<typeof payoutsPageSchema>;

/** SSE: a pay-out changed. Clients refetch it; the version tells them if they're stale. */
export const payoutEventSchema = z.object({
  payoutId: payoutIdSchema,
  status: z.enum(PAYOUT_STATUSES),
  version: versionSchema,
});
export type PayoutEvent = z.infer<typeof payoutEventSchema>;
