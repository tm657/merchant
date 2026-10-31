import type { NextRequest } from "next/server";
import { errorResponse, fetchMembers } from "@/lib/api.server";
import { orgIdSchema } from "@mini-payments/shared";

export async function GET(_req: NextRequest, ctx: RouteContext<"/api/orgs/[orgId]/members">) {
  const orgId = orgIdSchema.safeParse((await ctx.params).orgId);
  if (!orgId.success) return Response.json({ error: "invalid_request" }, { status: 400 });
  try {
    return Response.json(await fetchMembers(orgId.data));
  } catch (err) {
    return errorResponse(err);
  }
}
