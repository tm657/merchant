import type { NextRequest } from "next/server";
import { readJsonBody } from "@/lib/route-helpers.server";
import { apiRegister, errorResponse } from "@/lib/api.server";
import { rejectCrossOrigin } from "@/lib/csrf.server";
import { registerBodySchema } from "@mini-payments/shared";

export async function POST(req: NextRequest) {
  const csrf = rejectCrossOrigin(req);
  if (csrf) return csrf;

  const raw = await readJsonBody(req);

  if (!raw.ok) return raw.response;

  const body = registerBodySchema.safeParse(raw.value);
  if (!body.success) {
    return Response.json(
      {
        error: "invalid_request",
        issues: body.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
      },
      { status: 400 },
    );
  }

  try {
    await apiRegister(body.data);
    // The API answers the same whether or not the email was new, and so do we.
    return Response.json({ status: "accepted" }, { status: 202 });
  } catch (err) {
    return errorResponse(err);
  }
}
