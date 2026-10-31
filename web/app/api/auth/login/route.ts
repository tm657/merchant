import { cookies } from "next/headers";
import type { NextRequest } from "next/server";
import { apiLogin, errorResponse } from "@/lib/api.server";
import { sessionCookie } from "@/lib/auth.server";
import { rejectCrossOrigin } from "@/lib/csrf.server";
import { loginBodySchema } from "@mini-payments/shared";

export async function POST(req: NextRequest) {
  const csrf = rejectCrossOrigin(req);
  if (csrf) return csrf;

  const body = loginBodySchema.safeParse(await req.json().catch(() => null));
  // Same message as a wrong password: the form shouldn't hint at what was wrong.
  if (!body.success) return Response.json({ error: "invalid_credentials" }, { status: 401 });

  try {
    const { token, expiresAt, user } = await apiLogin(body.data);
    // The raw token goes only into the httpOnly cookie, never to browser JavaScript.
    (await cookies()).set(sessionCookie(req, token, expiresAt));
    return Response.json({ user });
  } catch (err) {
    return errorResponse(err);
  }
}
