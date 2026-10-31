import type { NextRequest } from "next/server";
import { errorResponse, fetchAudit } from "@/lib/api.server";
import { invalidRequest } from "@/lib/route-helpers.server";
import { auditQuerySchema, orgIdSchema } from "@mini-payments/shared";

export async function GET(req: NextRequest, ctx: RouteContext<"/api/orgs/[orgId]/audit">) {
  const orgId = orgIdSchema.safeParse((await ctx.params).orgId);
  if (!orgId.success) return invalidRequest(orgId.error);
  const query = auditQuerySchema.safeParse(Object.fromEntries(req.nextUrl.searchParams));
  if (!query.success) return invalidRequest(query.error);
  // Forward only validated values, never the raw query string.
  const upstream = new URLSearchParams();
  for (const [key, value] of Object.entries(query.data)) if (value !== undefined) upstream.set(key, String(value));
  try {
    return Response.json(await fetchAudit(orgId.data, upstream));
  } catch (err) {
    return errorResponse(err);
  }
}
