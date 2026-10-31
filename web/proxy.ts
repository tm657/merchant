import { REQUEST_ID_HEADER } from "@mini-payments/shared";
import { NextResponse, type NextRequest } from "next/server";
import { SESSION_COOKIE } from "@/lib/session-cookie";

// Pages that must stay reachable without a session.
const PUBLIC_PAGES = ["/login", "/register"];

/**
 * 1. Gives every request a fresh x-request-id. Server code reads it from the request
 *    headers, logs it, and forwards it to the API, so one ID ties both services' logs
 *    together. It's also returned to the browser for support. Any ID the browser sent is
 *    overwritten, so clients can't choose what appears in our logs.
 * 2. Convenience only: sends visitors without a session cookie to the login page.
 *    It does NOT check that the session is valid. Server components and route handlers
 *    do that by calling the API, which is where authorization is enforced.
 */
export function proxy(req: NextRequest) {
  const requestId = crypto.randomUUID();
  const { pathname } = req.nextUrl;
  // API routes answer 401 themselves.
  const needsSession = !pathname.startsWith("/api") && !PUBLIC_PAGES.some((p) => pathname === p || pathname.startsWith(`${p}/`));

  let res: NextResponse;
  if (needsSession && !req.cookies.has(SESSION_COOKIE)) {
    const login = new URL("/login", req.url);
    login.searchParams.set("next", pathname + req.nextUrl.search);
    res = NextResponse.redirect(login);
  } else {
    const headers = new Headers(req.headers);
    headers.set(REQUEST_ID_HEADER, requestId);
    res = NextResponse.next({ request: { headers } });
  }
  res.headers.set(REQUEST_ID_HEADER, requestId);
  return res;
}

export const config = {
  // Everything except static assets.
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
