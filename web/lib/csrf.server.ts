import "server-only";
import type { NextRequest } from "next/server";
import { getConfig } from "./config.server";

/**
 * CSRF check for state-changing BFF routes: the request must come from this app's own
 * origin. Browsers always send Origin on cross-site POSTs and can't forge it.
 * Set APP_ORIGIN when running behind a proxy that changes the Host header.
 */
export function rejectCrossOrigin(req: NextRequest): Response | null {
  const expected = getConfig().APP_ORIGIN ?? req.nextUrl.origin;
  const origin = req.headers.get("origin");
  const fetchSite = req.headers.get("sec-fetch-site");
  if (origin !== expected || (fetchSite !== null && fetchSite !== "same-origin")) {
    return Response.json({ error: "csrf_origin_mismatch" }, { status: 403 });
  }
  return null;
}
