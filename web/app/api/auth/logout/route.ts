import { cookies } from "next/headers";
import type { NextRequest } from "next/server";
import { apiLogout } from "@/lib/api.server";
import { sessionCookie } from "@/lib/auth.server";
import { rejectCrossOrigin } from "@/lib/csrf.server";
import { log } from "@/lib/log.server";

export async function POST(req: NextRequest) {
  const csrf = rejectCrossOrigin(req);
  if (csrf) return csrf;

  try {
    await apiLogout();
  } catch (err) {
    // Still clear the cookie: the user asked to log out. The session idles out on the API.
    await log.error("API logout failed", { err });
  }
  // Expire it with the attributes it was set with: a __Host- cookie can only be replaced
  // (and so cleared) by a Set-Cookie that is Secure with Path=/.
  (await cookies()).set({ ...sessionCookie(req, "", new Date(0).toISOString()), maxAge: 0 });
  return new Response(null, { status: 204 });
}
