import { PAYOUT_STATUSES, payoutIdSchema, type PayoutStatus } from "@mini-payments/shared";
import { z } from "zod";

// The pay-outs page keeps its inputs in the URL: ?status=approved&payout=po_...

export type PayoutFilters = { status?: PayoutStatus; payout?: string };

// Lenient: a bad value in a shared URL is dropped instead of breaking the page.
const lenient = z.object({
  status: z.enum(PAYOUT_STATUSES).optional().catch(undefined),
  payout: payoutIdSchema.optional().catch(undefined),
});

type SearchParamsLike = { get(name: string): string | null } | Record<string, string | string[] | undefined>;

function read(params: SearchParamsLike, key: string): string | undefined {
  if (typeof (params as URLSearchParams).get === "function") return (params as URLSearchParams).get(key) ?? undefined;
  const v = (params as Record<string, string | string[] | undefined>)[key];
  return Array.isArray(v) ? v[0] : v;
}

export function parsePayoutFilters(params: SearchParamsLike): PayoutFilters {
  return lenient.parse({ status: read(params, "status"), payout: read(params, "payout") });
}

export function payoutFiltersToSearch(f: PayoutFilters): URLSearchParams {
  const p = new URLSearchParams();
  if (f.status) p.set("status", f.status);
  if (f.payout) p.set("payout", f.payout);
  return p;
}
