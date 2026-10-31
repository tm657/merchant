import type { NextRequest } from "next/server";
import { errorResponse, exportAudit } from "@/lib/api.server";
import { rejectCrossOrigin } from "@/lib/csrf.server";
import { invalidRequest, readJsonBody } from "@/lib/route-helpers.server";
import { auditFiltersSchema, orgIdSchema } from "@mini-payments/shared";

/** POST, with CSRF check: an export is an audited action, not a plain read. */
export async function POST(req: NextRequest, ctx: RouteContext<"/api/orgs/[orgId]/audit/export">) {
  const csrf = rejectCrossOrigin(req);
  if (csrf) return csrf;
  const orgId = orgIdSchema.safeParse((await ctx.params).orgId);
  if (!orgId.success) return invalidRequest(orgId.error);
  const raw = await readJsonBody(req, { fallback: {} });
  if (!raw.ok) return raw.response;
  const filters = auditFiltersSchema.safeParse(raw.value);
  if (!filters.success) return invalidRequest(filters.error);
  try {
    return await exportAudit(orgId.data, filters.data);
  } catch (err) {
    return errorResponse(err);
  }
}
