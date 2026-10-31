import type { NextRequest } from "next/server";
import { errorResponse, reportsApi } from "@/lib/api.server";
import { rejectCrossOrigin } from "@/lib/csrf.server";
import { invalidRequest } from "@/lib/route-helpers.server";
import { exportFiltersSchema, orgIdSchema } from "@mini-payments/shared";

export async function GET(_req: NextRequest, ctx: RouteContext<"/api/orgs/[orgId]/exports">) {
  const orgId = orgIdSchema.safeParse((await ctx.params).orgId);
  if (!orgId.success) return invalidRequest(orgId.error);
  try {
    return Response.json(await reportsApi.listExports(orgId.data));
  } catch (err) {
    return errorResponse(err);
  }
}

/** Queues an export of the transactions list with these filters (the same schema as the list). */
export async function POST(req: NextRequest, ctx: RouteContext<"/api/orgs/[orgId]/exports">) {
  const csrf = rejectCrossOrigin(req);
  if (csrf) return csrf;
  const orgId = orgIdSchema.safeParse((await ctx.params).orgId);
  if (!orgId.success) return invalidRequest(orgId.error);
  const filters = exportFiltersSchema.safeParse(await req.json().catch(() => ({})));
  if (!filters.success) return invalidRequest(filters.error);
  try {
    return Response.json(await reportsApi.createExport(orgId.data, filters.data), { status: 202 });
  } catch (err) {
    return errorResponse(err);
  }
}
