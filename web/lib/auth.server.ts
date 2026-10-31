import "server-only";
import type { NextRequest } from "next/server";
import { redirect } from "next/navigation";
import { cache } from "react";
import { fetchMe, UpstreamError } from "./api.server";
import { getConfig } from "./config.server";
import type { Me } from "@mini-payments/shared";
import { SESSION_COOKIE } from "./session-cookie";

/**
 * The signed-in user, checked by the API on every request (never trusted from the cookie
 * alone). Deduplicated within one render. Null when there's no valid session.
 */
export const getCurrentUser = cache(async (): Promise<Me | null> => {
  try {
    return await fetchMe();
  } catch (err) {
    if (err instanceof UpstreamError && err.status === 401) return null;
    throw err;
  }
});

/** For server components: the user, or a redirect to the login page. */
export async function requireUser(): Promise<Me> {
  const me = await getCurrentUser();
  if (!me) redirect("/login?expired=1");
  return me;
}

// ---- Cookie ------------------------------------------------------------------

export function sessionCookie(req: NextRequest, token: string, expiresAt: string) {
  const maxAge = Math.max(0, Math.floor((Date.parse(expiresAt) - Date.now()) / 1000));
  return {
    name: SESSION_COOKIE,
    value: token,
    httpOnly: true,
    sameSite: "lax" as const,
    // __Host- cookies (production) are only accepted with Secure.
    secure: SESSION_COOKIE.startsWith("__Host-") || getConfig().NODE_ENV === "production" || req.nextUrl.protocol === "https:",
    path: "/",
    // Matches the session's absolute lifetime. The API still enforces the idle timeout.
    maxAge,
  };
}
