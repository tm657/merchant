import type { NextRequest } from "next/server";
import { errorResponse, reportsApi } from "@/lib/api.server";
import { exportIdSchema, orgIdSchema } from "@mini-payments/shared";

/**
 * A plain link target. The API checks the session, membership, role, org and expiry on
 * every request, so a copied link is useless to anyone else, or after 24 hours.
 */
export async function GET(_req: NextRequest, ctx: RouteContext<"/api/orgs/[orgId]/exports/[exportId]/download">) {
  const params = await ctx.params;
  const orgId = orgIdSchema.safeParse(params.orgId);
  const exportId = exportIdSchema.safeParse(params.exportId);
  if (!orgId.success) return Response.json({ error: "invalid_request" }, { status: 400 });
  if (!exportId.success) return Response.json({ error: "export_not_found" }, { status: 404 });
  try {
    return await reportsApi.download(orgId.data, exportId.data);
  } catch (err) {
    return errorResponse(err);
  }
}
