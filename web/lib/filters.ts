import {
  CURRENCIES,
  DEFAULT_DIR,
  DEFAULT_SORT,
  DIRS,
  SORTS,
  STATUSES,
  TRANSACTION_TYPES,
  type Currency,
  type SortDir,
  type SortKey,
  type Status,
  type TransactionType,
} from "@mini-payments/shared";
import { z } from "zod";

// Filters and sort live in the URL, so views are shareable and survive reload.

export type Filters = {
  type?: TransactionType;
  status?: Status;
  currency?: Currency;
  from?: string;
  to?: string;
  q?: string;
  sort: SortKey;
  dir: SortDir;
};

// Lenient: a bad value in a shared URL is dropped instead of breaking the page.
const lenientFilters = z.object({
  type: z.enum(TRANSACTION_TYPES).optional().catch(undefined),
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
    type: read(params, "type"),
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
  if (f.type) p.set("type", f.type);
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
