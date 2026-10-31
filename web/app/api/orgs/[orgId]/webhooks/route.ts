import type { NextRequest } from "next/server";
import { errorResponse, webhooksApi } from "@/lib/api.server";
import { rejectCrossOrigin } from "@/lib/csrf.server";
import { invalidRequest } from "@/lib/route-helpers.server";
import { createWebhookEndpointBodySchema, orgIdSchema } from "@mini-payments/shared";

export async function GET(_req: NextRequest, ctx: RouteContext<"/api/orgs/[orgId]/webhooks">) {
  const orgId = orgIdSchema.safeParse((await ctx.params).orgId);
  if (!orgId.success) return invalidRequest(orgId.error);
  try {
    return Response.json(await webhooksApi.list(orgId.data));
  } catch (err) {
    return errorResponse(err);
  }
}

/** The response carries the new secret: the only time it is ever shown. Never cached. */
export async function POST(req: NextRequest, ctx: RouteContext<"/api/orgs/[orgId]/webhooks">) {
  const csrf = rejectCrossOrigin(req);
  if (csrf) return csrf;
  const orgId = orgIdSchema.safeParse((await ctx.params).orgId);
  if (!orgId.success) return invalidRequest(orgId.error);
  const body = createWebhookEndpointBodySchema.safeParse(await req.json().catch(() => null));
  if (!body.success) return invalidRequest(body.error);
  try {
    return Response.json(await webhooksApi.create(orgId.data, body.data), { status: 201, headers: { "cache-control": "no-store" } });
  } catch (err) {
    return errorResponse(err);
  }
}
