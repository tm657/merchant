import type { NextRequest } from "next/server";
import { createPayout, errorResponse, fetchPayouts } from "@/lib/api.server";
import { rejectCrossOrigin } from "@/lib/csrf.server";
import { invalidRequest } from "@/lib/route-helpers.server";
import {
  createPayoutBodySchema,
  IDEMPOTENCY_KEY_HEADER,
  IDEMPOTENT_REPLAYED_HEADER,
  idempotencyKeySchema,
  orgIdSchema,
  payoutsQuerySchema,
} from "@mini-payments/shared";

export async function GET(req: NextRequest, ctx: RouteContext<"/api/orgs/[orgId]/payouts">) {
  const orgId = orgIdSchema.safeParse((await ctx.params).orgId);
  if (!orgId.success) return invalidRequest(orgId.error);
  const query = payoutsQuerySchema.safeParse(Object.fromEntries(req.nextUrl.searchParams));
  if (!query.success) return invalidRequest(query.error);

  // Forward only validated values, never the raw query string.
  const upstream = new URLSearchParams();
  for (const [key, value] of Object.entries(query.data)) if (value !== undefined) upstream.set(key, String(value));

  try {
    return Response.json(await fetchPayouts(orgId.data, upstream));
  } catch (err) {
    return errorResponse(err);
  }
}

export async function POST(req: NextRequest, ctx: RouteContext<"/api/orgs/[orgId]/payouts">) {
  const csrf = rejectCrossOrigin(req);
  if (csrf) return csrf;
  const orgId = orgIdSchema.safeParse((await ctx.params).orgId);
  if (!orgId.success) return invalidRequest(orgId.error);
  const key = idempotencyKeySchema.safeParse(req.headers.get(IDEMPOTENCY_KEY_HEADER));
  if (!key.success) return Response.json({ error: "idempotency_key_required" }, { status: 400 });
  const body = createPayoutBodySchema.safeParse(await req.json().catch(() => null));
  if (!body.success) return invalidRequest(body.error);

  try {
    const { status, replayed, data } = await createPayout(orgId.data, body.data, key.data);
    return Response.json(data, { status, headers: replayed ? { [IDEMPOTENT_REPLAYED_HEADER]: "true" } : {} });
  } catch (err) {
    return errorResponse(err);
  }
}
