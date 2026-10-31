import type { NextRequest } from "next/server";
import { errorResponse, webhooksApi } from "@/lib/api.server";
import { rejectCrossOrigin } from "@/lib/csrf.server";
import { orgIdSchema, webhookDeliveryIdSchema, webhookEndpointIdSchema } from "@mini-payments/shared";

export async function POST(
  req: NextRequest,
  ctx: RouteContext<"/api/orgs/[orgId]/webhooks/[endpointId]/deliveries/[deliveryId]/redeliver">,
) {
  const csrf = rejectCrossOrigin(req);
  if (csrf) return csrf;
  const p = await ctx.params;
  const orgId = orgIdSchema.safeParse(p.orgId);
  const endpointId = webhookEndpointIdSchema.safeParse(p.endpointId);
  const deliveryId = webhookDeliveryIdSchema.safeParse(p.deliveryId);
  if (!orgId.success) return Response.json({ error: "invalid_request" }, { status: 400 });
  if (!endpointId.success || !deliveryId.success) return Response.json({ error: "webhook_delivery_not_found" }, { status: 404 });
  try {
    return Response.json(await webhooksApi.redeliver(orgId.data, endpointId.data, deliveryId.data), { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}
