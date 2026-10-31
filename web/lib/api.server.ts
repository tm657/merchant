import "server-only";
import { cookies, headers } from "next/headers";
import type { z } from "zod";
import {
  balancesSchema,
  errorBodySchema,
  loginResponseSchema,
  meSchema,
  REQUEST_ID_HEADER,
  transactionsPageSchema,
  type Balances,
  type Me,
  type TransactionsPage,
} from "@mini-payments/shared";
import { getConfig } from "./config.server";
import { getRequestId, log } from "./log.server";
import { SESSION_COOKIE } from "./session-cookie";

const TIMEOUT_MS = 5000;

/** An error talking to the upstream API, already mapped to the status the BFF should return. */
export class UpstreamError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly retryAfter?: string,
  ) {
    super(code);
    this.name = "UpstreamError";
  }
}

export async function getSessionToken(): Promise<string | null> {
  return (await cookies()).get(SESSION_COOKIE)?.value ?? null;
}

/** Throws 401 without calling the API when there's no session cookie at all. */
async function authHeader(): Promise<{ authorization: string }> {
  const token = await getSessionToken();
  if (!token) throw new UpstreamError(401, "unauthenticated");
  return { authorization: `Bearer ${token}` };
}

async function request(path: string, init: RequestInit & { timeout?: boolean } = {}): Promise<Response> {
  // Forward this request's ID so the API logs under the same one.
  const requestId = await getRequestId();
  const headers = new Headers(init.headers);
  if (requestId) headers.set(REQUEST_ID_HEADER, requestId);
  try {
    return await fetch(`${getConfig().API_URL}${path}`, {
      ...init,
      headers,
      cache: "no-store",
      signal: init.signal ?? (init.timeout === false ? undefined : AbortSignal.timeout(TIMEOUT_MS)),
    });
  } catch (err) {
    if (err instanceof UpstreamError) throw err;
    if (err instanceof DOMException && err.name === "TimeoutError") {
      await log.warn("api request timed out", { path });
      throw new UpstreamError(504, "upstream_timeout");
    }
    await log.error("api request failed", { path, err });
    throw new UpstreamError(502, "upstream_unavailable");
  }
}

/** Maps an upstream error response to the status the BFF returns. */
async function toUpstreamError(res: Response): Promise<UpstreamError> {
  const code = errorBodySchema.safeParse(await res.json().catch(() => null)).data?.error;
  switch (res.status) {
    case 400:
      return new UpstreamError(400, code ?? "invalid_request");
    case 401:
      return new UpstreamError(401, code ?? "unauthenticated");
    case 403:
      return new UpstreamError(403, "forbidden");
    case 404:
      // Only a missing org is the caller's 404. Any other 404 (e.g. an API build without
      // this route) is a server problem, so don't pass it off as a clean 404.
      return code === "org_not_found"
        ? new UpstreamError(404, code)
        : new UpstreamError(502, "upstream_route_not_found");
    case 429:
      return new UpstreamError(429, code ?? "too_many_attempts", res.headers.get("retry-after") ?? undefined);
    default:
      return new UpstreamError(502, "upstream_error");
  }
}

async function getJson<T>(path: string, schema: z.ZodType<T>): Promise<T> {
  const res = await request(path, { headers: { accept: "application/json", ...(await authHeader()) } });
  if (!res.ok) throw await toUpstreamError(res);
  const parsed = schema.safeParse(await res.json().catch(() => null));
  if (!parsed.success) {
    await log.error("api response failed validation", { path, issues: parsed.error.issues.slice(0, 5) });
    throw new UpstreamError(502, "bad_upstream_response");
  }
  return parsed.data;
}

const orgPath = (orgId: string) => `/orgs/${encodeURIComponent(orgId)}`;

export function fetchTransactions(orgId: string, query: URLSearchParams): Promise<TransactionsPage> {
  const qs = query.toString();
  return getJson(`${orgPath(orgId)}/transactions${qs ? `?${qs}` : ""}`, transactionsPageSchema);
}

export function fetchBalances(orgId: string): Promise<Balances> {
  return getJson(`${orgPath(orgId)}/balances`, balancesSchema);
}

export function fetchMe(): Promise<Me> {
  return getJson("/me", meSchema);
}

/**
 * Opens the upstream SSE stream with the session. Aborting `signal` (the browser's
 * request) closes it. No timeout: the stream is meant to stay open.
 */
export async function openEventStream(orgId: string, signal: AbortSignal): Promise<ReadableStream<Uint8Array>> {
  const res = await request(`${orgPath(orgId)}/events`, {
    headers: { accept: "text/event-stream", ...(await authHeader()) },
    signal,
    timeout: false,
  });
  if (!res.ok || !res.body) throw await toUpstreamError(res);
  return res.body;
}

// ---- Auth calls --------------------------------------------------------------

/**
 * Headers telling the API who the browser is. The API trusts X-Forwarded-For only from
 * loopback (this BFF), and uses it to rate limit per client IP.
 */
async function clientHeaders(): Promise<Record<string, string>> {
  const h = await headers();
  // Next.js fills X-Forwarded-For with the socket address only if the request has none.
  // Behind a reverse proxy that appends the client IP (nginx, a load balancer), the last
  // entry is the real client. Exposed directly, a client can send its own header and dodge
  // the per-IP limit (the per-email lockout still applies), so deploy behind a proxy.
  const ip = h.get("x-forwarded-for")?.split(",").at(-1)?.trim();
  const ua = h.get("user-agent");
  return {
    "content-type": "application/json",
    ...(ip ? { "x-forwarded-for": ip } : {}),
    ...(ua ? { "user-agent": ua } : {}),
  };
}

export async function apiLogin(body: { email: string; password: string }) {
  // Send the browser's current session (if any) so the API rotates it away.
  const old = await getSessionToken();
  const res = await request("/auth/login", {
    method: "POST",
    headers: { ...(await clientHeaders()), ...(old ? { authorization: `Bearer ${old}` } : {}) },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw await toUpstreamError(res);
  const parsed = loginResponseSchema.safeParse(await res.json().catch(() => null));
  if (!parsed.success) throw new UpstreamError(502, "bad_upstream_response");
  return parsed.data;
}

export async function apiRegister(body: { name: string; email: string; password: string }): Promise<void> {
  const res = await request("/auth/register", {
    method: "POST",
    headers: await clientHeaders(),
    body: JSON.stringify(body),
  });
  if (!res.ok) throw await toUpstreamError(res);
}

export async function apiLogout(): Promise<void> {
  const token = await getSessionToken();
  if (!token) return;
  const res = await request("/auth/logout", { method: "POST", headers: { authorization: `Bearer ${token}` } });
  if (!res.ok) throw await toUpstreamError(res);
}

/** Turns any error into a clean JSON response for a route handler. */
export async function errorResponse(err: unknown): Promise<Response> {
  if (err instanceof UpstreamError) {
    if (err.status >= 500) await log.warn("upstream error", { status: err.status, code: err.code });
    return Response.json(
      { error: err.code },
      { status: err.status, headers: err.retryAfter ? { "retry-after": err.retryAfter } : {} },
    );
  }
  await log.error("unhandled error in route handler", { err });
  return Response.json({ error: "internal_error" }, { status: 500 });
}
