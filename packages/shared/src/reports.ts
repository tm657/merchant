import { z } from "zod";
import { CURRENCIES } from "./currency.ts";
import { DIRS, SORTS, STATUSES, TRANSACTION_TYPES } from "./schemas.ts";

// ---- CSV exports ---------------------------------------------------------------

export const EXPORT_STATUSES = ["queued", "running", "completed", "failed", "expired"] as const;
export type ExportStatus = (typeof EXPORT_STATUSES)[number];

/** At most this many exports run at once per org (enforced in Redis). */
export const MAX_RUNNING_EXPORTS_PER_ORG = 2;
/** POST /exports answers 429 once an org has this many queued or running. */
export const MAX_PENDING_EXPORTS_PER_ORG = 20;
export const EXPORT_TTL_HOURS = 24;

export const exportIdSchema = z.string().regex(/^exp_[A-Za-z0-9-]{1,64}$/);

const validRange = (v: { from?: string; to?: string }) => !v.from || !v.to || v.from <= v.to;
const rangeError = { message: "from must be on or before to", path: ["from"] };

/** The same filters and sort as the transactions list (no cursor or page size). */
export const exportFiltersSchema = z
  .object({
    type: z.enum(TRANSACTION_TYPES).optional(),
    status: z.enum(STATUSES).optional(),
    currency: z.enum(CURRENCIES).optional(),
    from: z.iso.date().optional(),
    to: z.iso.date().optional(),
    q: z.string().trim().min(1).max(100).optional(),
    sort: z.enum(SORTS).default("createdAt"),
    dir: z.enum(DIRS).default("desc"),
  })
  .strict()
  .refine(validRange, rangeError);
export type ExportFilters = z.infer<typeof exportFiltersSchema>;

export const exportJobSchema = z.object({
  id: exportIdSchema,
  status: z.enum(EXPORT_STATUSES),
  filters: z.record(z.string(), z.unknown()),
  requestedBy: z.object({ id: z.string(), name: z.string() }),
  rowsTotal: z.number().int().nullable(),
  rowsWritten: z.number().int(),
  bytesWritten: z.number().int(),
  error: z.string().nullable(),
  createdAt: z.iso.datetime(),
  startedAt: z.iso.datetime().nullable(),
  completedAt: z.iso.datetime().nullable(),
  expiresAt: z.iso.datetime().nullable(),
  /** True while the file can be downloaded. */
  downloadable: z.boolean(),
});
export type ExportJob = z.infer<typeof exportJobSchema>;
export const exportJobResponseSchema = z.object({ export: exportJobSchema });
export const exportJobListSchema = z.object({ items: z.array(exportJobSchema) });

/** SSE: an export's progress or final state. Clients refetch the list on final states. */
export const exportEventSchema = z.object({
  exportId: exportIdSchema,
  status: z.enum(EXPORT_STATUSES),
  rowsWritten: z.number().int(),
  rowsTotal: z.number().int().nullable(),
});
export type ExportEvent = z.infer<typeof exportEventSchema>;

// ---- Settlements ---------------------------------------------------------------

export const settlementSchema = z.object({
  date: z.iso.date(),
  currency: z.enum(CURRENCIES),
  payinCount: z.number().int(),
  /** Integer minor units. */
  payinAmount: z.number().int(),
  payoutCount: z.number().int(),
  /** Integer minor units, negative (money out). */
  payoutAmount: z.number().int(),
  /** payinAmount + payoutAmount. */
  netAmount: z.number().int(),
  computedAt: z.iso.datetime(),
});
export type Settlement = z.infer<typeof settlementSchema>;

export const settlementTotalsSchema = z.object({
  currency: z.enum(CURRENCIES),
  payinCount: z.number().int(),
  payinAmount: z.number().int(),
  payoutCount: z.number().int(),
  payoutAmount: z.number().int(),
  netAmount: z.number().int(),
});

export const settlementsResponseSchema = z.object({
  from: z.iso.date(),
  to: z.iso.date(),
  items: z.array(settlementSchema),
  /** One row per currency over the whole range. */
  totals: z.array(settlementTotalsSchema),
});
export type SettlementsResponse = z.infer<typeof settlementsResponseSchema>;

/** Settlements cover whole UTC days; at most a year per request. */
export const settlementsQuerySchema = z
  .object({ from: z.iso.date(), to: z.iso.date() })
  .strict()
  .refine((v) => v.from <= v.to, rangeError)
  .refine((v) => Date.parse(v.to) - Date.parse(v.from) <= 366 * 86_400_000, { message: "at most 366 days", path: ["to"] });
