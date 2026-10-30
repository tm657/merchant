import { NextResponse, type NextRequest } from "next/server";
import { SESSION_COOKIE } from "@/lib/session-cookie";

/**
 * Convenience only: sends visitors without a session cookie to the login page.
 * It does NOT check that the session is valid. Server components and route handlers
 * do that by calling the API, which is where authorization is enforced.
 */
export function proxy(req: NextRequest) {
  if (req.cookies.has(SESSION_COOKIE)) return NextResponse.next();
  const login = new URL("/login", req.url);
  login.searchParams.set("next", req.nextUrl.pathname + req.nextUrl.search);
  return NextResponse.redirect(login);
}

export const config = {
  // Pages only. API routes answer 401 themselves; login/register must stay reachable.
  matcher: ["/((?!api|_next/static|_next/image|favicon.ico|login|register).*)"],
};
