import type { NextRequest } from "next/server";
import { errorResponse, reportsApi } from "@/lib/api.server";
import { invalidRequest } from "@/lib/route-helpers.server";
import { orgIdSchema, settlementsQuerySchema } from "@mini-payments/shared";

export async function GET(req: NextRequest, ctx: RouteContext<"/api/orgs/[orgId]/settlements">) {
  const orgId = orgIdSchema.safeParse((await ctx.params).orgId);
  if (!orgId.success) return invalidRequest(orgId.error);
  const query = settlementsQuerySchema.safeParse(Object.fromEntries(req.nextUrl.searchParams));
  if (!query.success) return invalidRequest(query.error);
  try {
    return Response.json(await reportsApi.settlements(orgId.data, query.data.from, query.data.to));
  } catch (err) {
    return errorResponse(err);
  }
}
