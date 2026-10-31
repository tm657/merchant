import type { NextRequest } from "next/server";
import { errorResponse, webhooksApi } from "@/lib/api.server";
import { invalidRequest } from "@/lib/route-helpers.server";
import { orgIdSchema, webhookDeliveriesQuerySchema, webhookEndpointIdSchema } from "@mini-payments/shared";

export async function GET(req: NextRequest, ctx: RouteContext<"/api/orgs/[orgId]/webhooks/[endpointId]/deliveries">) {
  const p = await ctx.params;
  const orgId = orgIdSchema.safeParse(p.orgId);
  const endpointId = webhookEndpointIdSchema.safeParse(p.endpointId);
  if (!orgId.success) return Response.json({ error: "invalid_request" }, { status: 400 });
  if (!endpointId.success) return Response.json({ error: "webhook_endpoint_not_found" }, { status: 404 });
  const query = webhookDeliveriesQuerySchema.safeParse(Object.fromEntries(req.nextUrl.searchParams));
  if (!query.success) return invalidRequest(query.error);
  const upstream = new URLSearchParams();
  for (const [key, value] of Object.entries(query.data)) if (value !== undefined) upstream.set(key, String(value));
  try {
    return Response.json(await webhooksApi.deliveries(orgId.data, endpointId.data, upstream));
  } catch (err) {
    return errorResponse(err);
  }
}
