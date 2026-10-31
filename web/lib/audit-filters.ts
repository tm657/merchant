import { AUDIT_ACTIONS, type AuditFilters } from "@mini-payments/shared";
import { z } from "zod";

// The audit page keeps its filters in the URL: ?actor=&action=&from=&to=

const lenient = z.object({
  actor: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/).optional().catch(undefined),
  action: z.enum(AUDIT_ACTIONS).optional().catch(undefined),
  from: z.iso.date().optional().catch(undefined),
  to: z.iso.date().optional().catch(undefined),
});

type SearchParamsLike = { get(name: string): string | null } | Record<string, string | string[] | undefined>;

function read(params: SearchParamsLike, key: string): string | undefined {
  if (typeof (params as URLSearchParams).get === "function") return (params as URLSearchParams).get(key) ?? undefined;
  const v = (params as Record<string, string | string[] | undefined>)[key];
  return Array.isArray(v) ? v[0] : v;
}

/** Bad values in a shared URL are dropped instead of breaking the page. */
export function parseAuditFilters(params: SearchParamsLike): AuditFilters {
  const f = lenient.parse({ actor: read(params, "actor"), action: read(params, "action"), from: read(params, "from"), to: read(params, "to") });
  if (f.from && f.to && f.from > f.to) f.to = undefined;
  return f;
}

export function auditFiltersToSearch(f: AuditFilters): URLSearchParams {
  const p = new URLSearchParams();
  for (const k of ["actor", "action", "from", "to"] as const) if (f[k]) p.set(k, f[k]);
  return p;
}
