import type { NextRequest } from "next/server";
import type { z } from "zod";
import { errorResponse, fetchTransactions } from "@/lib/api.server";
import { orgIdSchema, transactionsQuerySchema } from "@/lib/schemas";

function invalid(error: z.ZodError) {
  return Response.json(
    {
      error: "invalid_request",
      issues: error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
    },
    { status: 400 },
  );
}

export async function GET(req: NextRequest, ctx: RouteContext<"/api/orgs/[orgId]/transactions">) {
  const orgId = orgIdSchema.safeParse((await ctx.params).orgId);
  if (!orgId.success) return invalid(orgId.error);

  const query = transactionsQuerySchema.safeParse(Object.fromEntries(req.nextUrl.searchParams));
  if (!query.success) return invalid(query.error);

  // Forward only validated values, never the raw query string.
  const upstream = new URLSearchParams();
  for (const [key, value] of Object.entries(query.data)) {
    if (value !== undefined) upstream.set(key, String(value));
  }

  try {
    return Response.json(await fetchTransactions(orgId.data, upstream));
  } catch (err) {
    return errorResponse(err);
  }
}
