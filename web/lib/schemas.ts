import { z } from "zod";

// Mirrors the API contract in api/src. Used by the BFF (to parse API responses)
// and by the browser (to parse BFF responses).

export const STATUSES = ["pending", "success", "failed"] as const;
export type Status = (typeof STATUSES)[number];

export const CURRENCIES = ["USD", "IDR", "PHP"] as const;
export type Currency = (typeof CURRENCIES)[number];

export const SORTS = ["createdAt", "amount"] as const;
export type SortKey = (typeof SORTS)[number];

export const DIRS = ["asc", "desc"] as const;
export type SortDir = (typeof DIRS)[number];

export const ORG_IDS = ["org_1", "org_2", "org_3"] as const;

export const orgIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);

// Money is an integer in minor units plus a currency code.
const minorUnits = z.number().int();

export const transactionSchema = z.object({
  id: z.string(),
  merchant: z.string(),
  amount: minorUnits,
  currency: z.enum(CURRENCIES),
  status: z.enum(STATUSES),
  createdAt: z.iso.datetime(),
});
export type Transaction = z.infer<typeof transactionSchema>;

export const transactionsPageSchema = z.object({
  items: z.array(transactionSchema),
  nextCursor: z.string().nullable(),
});
export type TransactionsPage = z.infer<typeof transactionsPageSchema>;

export const balancesSchema = z.object({
  balances: z.array(z.object({ currency: z.enum(CURRENCIES), available: minorUnits })),
});
export type Balances = z.infer<typeof balancesSchema>;

export const errorBodySchema = z.object({ error: z.string() });

/** Strict query schema for the BFF transactions route. Bad input is a 400. */
export const transactionsQuerySchema = z
  .object({
    status: z.enum(STATUSES).optional(),
    currency: z.enum(CURRENCIES).optional(),
    from: z.iso.date().optional(),
    to: z.iso.date().optional(),
    q: z.string().trim().min(1).max(100).optional(),
    sort: z.enum(SORTS).optional(),
    dir: z.enum(DIRS).optional(),
    cursor: z.string().min(1).max(500).optional(),
    limit: z.coerce.number().int().min(1).max(100).optional(),
  })
  .strict()
  .refine((v) => !v.from || !v.to || v.from <= v.to, {
    message: "from must be on or before to",
    path: ["from"],
  });
export type TransactionsQuery = z.infer<typeof transactionsQuerySchema>;

// ---- Filters in the URL ----------------------------------------------------

export type Filters = {
  status?: Status;
  currency?: Currency;
  from?: string;
  to?: string;
  q?: string;
  sort: SortKey;
  dir: SortDir;
};

export const DEFAULT_SORT: SortKey = "createdAt";
export const DEFAULT_DIR: SortDir = "desc";

// Lenient: a bad value in a shared URL is dropped instead of breaking the page.
const lenientFilters = z.object({
  status: z.enum(STATUSES).optional().catch(undefined),
  currency: z.enum(CURRENCIES).optional().catch(undefined),
  from: z.iso.date().optional().catch(undefined),
  to: z.iso.date().optional().catch(undefined),
  q: z.string().trim().min(1).max(100).optional().catch(undefined),
  sort: z.enum(SORTS).catch(DEFAULT_SORT),
  dir: z.enum(DIRS).catch(DEFAULT_DIR),
});

type SearchParamsLike =
  | URLSearchParams
  | { get(name: string): string | null }
  | Record<string, string | string[] | undefined>;

function read(params: SearchParamsLike, key: string): string | undefined {
  if (typeof (params as URLSearchParams).get === "function") {
    return (params as URLSearchParams).get(key) ?? undefined;
  }
  const v = (params as Record<string, string | string[] | undefined>)[key];
  return Array.isArray(v) ? v[0] : v;
}

export function parseFilters(params: SearchParamsLike): Filters {
  const f = lenientFilters.parse({
    status: read(params, "status"),
    currency: read(params, "currency"),
    from: read(params, "from"),
    to: read(params, "to"),
    q: read(params, "q"),
    sort: read(params, "sort"),
    dir: read(params, "dir"),
  });
  // An inverted range would be rejected upstream, so ignore the end date.
  if (f.from && f.to && f.from > f.to) f.to = undefined;
  return f;
}

/** Only non-default values are written, so URLs stay short and stable. */
export function filtersToSearch(f: Filters): URLSearchParams {
  const p = new URLSearchParams();
  if (f.status) p.set("status", f.status);
  if (f.currency) p.set("currency", f.currency);
  if (f.from) p.set("from", f.from);
  if (f.to) p.set("to", f.to);
  if (f.q) p.set("q", f.q);
  if (f.sort !== DEFAULT_SORT) p.set("sort", f.sort);
  if (f.dir !== DEFAULT_DIR) p.set("dir", f.dir);
  return p;
}

/** Query string for a page request: filters plus an optional cursor. */
export function pageQuery(f: Filters, cursor: string | null): URLSearchParams {
  const p = filtersToSearch(f);
  // Always send sort/dir upstream so cursors are validated against them.
  p.set("sort", f.sort);
  p.set("dir", f.dir);
  if (cursor) p.set("cursor", cursor);
  return p;
}
