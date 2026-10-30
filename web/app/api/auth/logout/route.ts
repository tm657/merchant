import { cookies } from "next/headers";
import type { NextRequest } from "next/server";
import { apiLogout } from "@/lib/api.server";
import { rejectCrossOrigin } from "@/lib/csrf.server";
import { SESSION_COOKIE } from "@/lib/session-cookie";

export async function POST(req: NextRequest) {
  const csrf = rejectCrossOrigin(req);
  if (csrf) return csrf;

  try {
    await apiLogout();
  } catch (err) {
    // Still clear the cookie: the user asked to log out. The session idles out on the API.
    console.error("API logout failed:", err);
  }
  (await cookies()).delete(SESSION_COOKIE);
  return new Response(null, { status: 204 });
}
