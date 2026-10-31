import type { NextRequest } from "next/server";
import { decidePayout, errorResponse } from "@/lib/api.server";
import { rejectCrossOrigin } from "@/lib/csrf.server";
import { invalidRequest, readJsonBody } from "@/lib/route-helpers.server";
import {
  approvePayoutBodySchema,
  cancelPayoutBodySchema,
  orgIdSchema,
  PAYOUT_ACTIONS,
  payoutIdSchema,
  rejectPayoutBodySchema,
  type PayoutAction,
} from "@mini-payments/shared";
import { z } from "zod";

const BODY_SCHEMAS = {
  approve: approvePayoutBodySchema,
  reject: rejectPayoutBodySchema,
  cancel: cancelPayoutBodySchema,
} satisfies Record<PayoutAction, z.ZodType>;

/** POST /api/orgs/:orgId/payouts/:payoutId/(approve|reject|cancel) */
export async function POST(req: NextRequest, ctx: RouteContext<"/api/orgs/[orgId]/payouts/[payoutId]/[action]">) {
  const csrf = rejectCrossOrigin(req);
  if (csrf) return csrf;
  const params = await ctx.params;
  const orgId = orgIdSchema.safeParse(params.orgId);
  const payoutId = payoutIdSchema.safeParse(params.payoutId);
  const action = z.enum(PAYOUT_ACTIONS).safeParse(params.action);
  if (!orgId.success) return Response.json({ error: "invalid_request" }, { status: 400 });
  if (!payoutId.success || !action.success) return Response.json({ error: "not_found" }, { status: 404 });

  const raw = await readJsonBody(req);

  if (!raw.ok) return raw.response;

  const body = BODY_SCHEMAS[action.data].safeParse(raw.value);
  if (!body.success) return invalidRequest(body.error);

  try {
    return Response.json(await decidePayout(orgId.data, payoutId.data, action.data, body.data));
  } catch (err) {
    return errorResponse(err);
  }
}
