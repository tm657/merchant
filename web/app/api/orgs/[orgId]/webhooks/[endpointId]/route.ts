import type { NextRequest } from "next/server";
import { errorResponse, webhooksApi } from "@/lib/api.server";
import { rejectCrossOrigin } from "@/lib/csrf.server";
import { invalidRequest } from "@/lib/route-helpers.server";
import { orgIdSchema, updateWebhookEndpointBodySchema, webhookEndpointIdSchema } from "@mini-payments/shared";

type Ctx = RouteContext<"/api/orgs/[orgId]/webhooks/[endpointId]">;

async function ids(ctx: Ctx) {
  const p = await ctx.params;
  const orgId = orgIdSchema.safeParse(p.orgId);
  const endpointId = webhookEndpointIdSchema.safeParse(p.endpointId);
  if (!orgId.success) return { error: Response.json({ error: "invalid_request" }, { status: 400 }) };
  if (!endpointId.success) return { error: Response.json({ error: "webhook_endpoint_not_found" }, { status: 404 }) };
  return { orgId: orgId.data, endpointId: endpointId.data };
}

export async function GET(_req: NextRequest, ctx: Ctx) {
  const r = await ids(ctx);
  if ("error" in r) return r.error;
  try {
    return Response.json(await webhooksApi.get(r.orgId, r.endpointId));
  } catch (err) {
    return errorResponse(err);
  }
}

export async function PATCH(req: NextRequest, ctx: Ctx) {
  const csrf = rejectCrossOrigin(req);
  if (csrf) return csrf;
  const r = await ids(ctx);
  if ("error" in r) return r.error;
  const body = updateWebhookEndpointBodySchema.safeParse(await req.json().catch(() => null));
  if (!body.success) return invalidRequest(body.error);
  try {
    return Response.json(await webhooksApi.update(r.orgId, r.endpointId, body.data));
  } catch (err) {
    return errorResponse(err);
  }
}

export async function DELETE(req: NextRequest, ctx: Ctx) {
  const csrf = rejectCrossOrigin(req);
  if (csrf) return csrf;
  const r = await ids(ctx);
  if ("error" in r) return r.error;
  try {
    await webhooksApi.remove(r.orgId, r.endpointId);
    return new Response(null, { status: 204 });
  } catch (err) {
    return errorResponse(err);
  }
}
