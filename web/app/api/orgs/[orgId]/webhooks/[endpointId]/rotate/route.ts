import type { NextRequest } from "next/server";
import { errorResponse, webhooksApi } from "@/lib/api.server";
import { rejectCrossOrigin } from "@/lib/csrf.server";
import { orgIdSchema, webhookEndpointIdSchema } from "@mini-payments/shared";

/** The response carries the new secret: the only time it is ever shown. Never cached. */
export async function POST(req: NextRequest, ctx: RouteContext<"/api/orgs/[orgId]/webhooks/[endpointId]/rotate">) {
  const csrf = rejectCrossOrigin(req);
  if (csrf) return csrf;
  const p = await ctx.params;
  const orgId = orgIdSchema.safeParse(p.orgId);
  const endpointId = webhookEndpointIdSchema.safeParse(p.endpointId);
  if (!orgId.success) return Response.json({ error: "invalid_request" }, { status: 400 });
  if (!endpointId.success) return Response.json({ error: "webhook_endpoint_not_found" }, { status: 404 });
  try {
    return Response.json(await webhooksApi.rotate(orgId.data, endpointId.data), { headers: { "cache-control": "no-store" } });
  } catch (err) {
    return errorResponse(err);
  }
}
