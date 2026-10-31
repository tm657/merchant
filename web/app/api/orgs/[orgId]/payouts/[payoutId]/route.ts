import type { NextRequest } from "next/server";
import { errorResponse, fetchPayout } from "@/lib/api.server";
import { orgIdSchema, payoutIdSchema } from "@mini-payments/shared";

export async function GET(_req: NextRequest, ctx: RouteContext<"/api/orgs/[orgId]/payouts/[payoutId]">) {
  const params = await ctx.params;
  const orgId = orgIdSchema.safeParse(params.orgId);
  const payoutId = payoutIdSchema.safeParse(params.payoutId);
  if (!orgId.success) return Response.json({ error: "invalid_request" }, { status: 400 });
  if (!payoutId.success) return Response.json({ error: "payout_not_found" }, { status: 404 });

  try {
    return Response.json(await fetchPayout(orgId.data, payoutId.data));
  } catch (err) {
    return errorResponse(err);
  }
}
