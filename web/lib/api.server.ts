import "server-only";
import { cookies, headers } from "next/headers";
import { z } from "zod";
import {
  auditPageSchema,
  exportJobListSchema,
  exportJobResponseSchema,
  settlementsResponseSchema,
  type ExportFilters,
  orgMembersSchema,
  webhookDeliveriesPageSchema,
  webhookDeliveryResponseSchema,
  webhookEndpointListSchema,
  webhookEndpointResponseSchema,
  webhookSecretResponseSchema,
  type AuditFilters,
  type AuditPage,
  type CreateWebhookEndpointBody,
  type OrgMembers,
  type UpdateWebhookEndpointBody,
} from "@mini-payments/shared";
import {
  balancesSchema,
  errorBodySchema,
  IDEMPOTENCY_KEY_HEADER,
  IDEMPOTENT_REPLAYED_HEADER,
  loginResponseSchema,
  meSchema,
  payoutDetailSchema,
  payoutResponseSchema,
  payoutsPageSchema,
  REQUEST_ID_HEADER,
  transactionsPageSchema,
  type Balances,
  type CreatePayoutBody,
  type Me,
  type PayoutAction,
  type PayoutDetail,
  type PayoutsPage,
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
    readonly detail?: string,
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

const PASS_THROUGH_403 = new Set(["self_approval_forbidden", "self_rejection_forbidden", "not_creator"]);
const PASS_THROUGH_404 = new Set([
  "export_not_found",
  "org_not_found",
  "payout_not_found",
  "webhook_endpoint_not_found",
  "webhook_delivery_not_found",
]);

/** Maps an upstream error response to the status the BFF returns. */
async function toUpstreamError(res: Response): Promise<UpstreamError> {
  const body: unknown = await res.json().catch(() => null);
  const code = errorBodySchema.safeParse(body).data?.error;
  // A human-readable reason the API chose to share (e.g. why a webhook URL is refused).
  const detail = z.object({ message: z.string().max(300) }).safeParse(body).data?.message;
  switch (res.status) {
    case 400:
      return new UpstreamError(400, code ?? "invalid_request", undefined, detail);
    case 401:
      return new UpstreamError(401, code ?? "unauthenticated");
    case 403:
      // Pay-out rules the UI explains; every other 403 stays a plain "forbidden".
      return new UpstreamError(403, code && PASS_THROUGH_403.has(code) ? code : "forbidden");
    case 404:
      // Only a missing org or pay-out is the caller's 404. Any other 404 (e.g. an API build
      // without this route) is a server problem, so don't pass it off as a clean 404.
      return code && PASS_THROUGH_404.has(code)
        ? new UpstreamError(404, code)
        : new UpstreamError(502, "upstream_route_not_found");
    case 409:
      // version_conflict, invalid_transition, insufficient_funds, export_not_ready, ...
      return new UpstreamError(409, code ?? "conflict");
    case 410:
      // export_expired
      return new UpstreamError(410, code ?? "gone");
    case 422:
      return new UpstreamError(422, code ?? "unprocessable");
    case 429:
      return new UpstreamError(429, code ?? "too_many_attempts", res.headers.get("retry-after") ?? undefined);
    case 503:
      // e.g. login/register while the API's rate limiter (Redis) is down: fail closed.
      return new UpstreamError(503, code ?? "service_unavailable", res.headers.get("retry-after") ?? undefined);
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

// ---- Pay-outs ------------------------------------------------------------------

async function postJson<T>(path: string, body: unknown, schema: z.ZodType<T>, extraHeaders: Record<string, string> = {}) {
  const res = await request(path, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json", ...extraHeaders, ...(await authHeader()) },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw await toUpstreamError(res);
  const parsed = schema.safeParse(await res.json().catch(() => null));
  if (!parsed.success) {
    await log.error("api response failed validation", { path, issues: parsed.error.issues.slice(0, 5) });
    throw new UpstreamError(502, "bad_upstream_response");
  }
  return { status: res.status, headers: res.headers, data: parsed.data };
}

const payoutPath = (orgId: string, payoutId: string) => `${orgPath(orgId)}/payouts/${encodeURIComponent(payoutId)}`;

export function fetchPayouts(orgId: string, query: URLSearchParams): Promise<PayoutsPage> {
  const qs = query.toString();
  return getJson(`${orgPath(orgId)}/payouts${qs ? `?${qs}` : ""}`, payoutsPageSchema);
}

export function fetchPayout(orgId: string, payoutId: string): Promise<PayoutDetail> {
  return getJson(payoutPath(orgId, payoutId), payoutDetailSchema);
}

/** Forwards the browser's Idempotency-Key; reports whether the API replayed a stored response. */
export async function createPayout(orgId: string, body: CreatePayoutBody, idempotencyKey: string) {
  const res = await postJson(`${orgPath(orgId)}/payouts`, body, payoutResponseSchema, {
    [IDEMPOTENCY_KEY_HEADER]: idempotencyKey,
  });
  return { status: res.status, replayed: res.headers.get(IDEMPOTENT_REPLAYED_HEADER) === "true", data: res.data };
}

// ---- Audit log and webhooks (admin) -----------------------------------------------

/** Any method; JSON in, JSON (or nothing, for 204) out, validated against `schema`. */
async function sendJson<T>(method: string, path: string, body: unknown, schema: z.ZodType<T>): Promise<T> {
  const res = await request(path, {
    method,
    headers: {
      accept: "application/json",
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...(await authHeader()),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) throw await toUpstreamError(res);
  const parsed = schema.safeParse(res.status === 204 ? null : await res.json().catch(() => null));
  if (!parsed.success) {
    await log.error("api response failed validation", { path, issues: parsed.error.issues.slice(0, 5) });
    throw new UpstreamError(502, "bad_upstream_response");
  }
  return parsed.data;
}

export function fetchAudit(orgId: string, query: URLSearchParams): Promise<AuditPage> {
  const qs = query.toString();
  return getJson(`${orgPath(orgId)}/audit${qs ? `?${qs}` : ""}`, auditPageSchema);
}

export function fetchMembers(orgId: string): Promise<OrgMembers> {
  return getJson(`${orgPath(orgId)}/members`, orgMembersSchema);
}

/** The CSV as the API produced it, with its download headers. */
export async function exportAudit(orgId: string, filters: AuditFilters): Promise<Response> {
  const res = await request(`${orgPath(orgId)}/audit/export`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(await authHeader()) },
    body: JSON.stringify(filters),
  });
  if (!res.ok) throw await toUpstreamError(res);
  const headers = new Headers();
  for (const h of ["content-type", "content-disposition", "x-export-rows", "x-export-truncated"]) {
    const v = res.headers.get(h);
    if (v) headers.set(h, v);
  }
  headers.set("cache-control", "no-store");
  return new Response(res.body, { status: 200, headers });
}

const webhooksPath = (orgId: string) => `${orgPath(orgId)}/webhooks`;
const endpointPath = (orgId: string, id: string) => `${webhooksPath(orgId)}/${encodeURIComponent(id)}`;

export const webhooksApi = {
  list: (orgId: string) => getJson(webhooksPath(orgId), webhookEndpointListSchema),
  get: (orgId: string, id: string) => getJson(endpointPath(orgId, id), webhookEndpointResponseSchema),
  create: (orgId: string, body: CreateWebhookEndpointBody) => sendJson("POST", webhooksPath(orgId), body, webhookSecretResponseSchema),
  update: (orgId: string, id: string, body: UpdateWebhookEndpointBody) =>
    sendJson("PATCH", endpointPath(orgId, id), body, webhookEndpointResponseSchema),
  remove: (orgId: string, id: string) => sendJson("DELETE", endpointPath(orgId, id), undefined, z.null()),
  rotate: (orgId: string, id: string) => sendJson("POST", `${endpointPath(orgId, id)}/rotate`, undefined, webhookSecretResponseSchema),
  deliveries: (orgId: string, id: string, query: URLSearchParams) => {
    const qs = query.toString();
    return getJson(`${endpointPath(orgId, id)}/deliveries${qs ? `?${qs}` : ""}`, webhookDeliveriesPageSchema);
  },
  redeliver: (orgId: string, id: string, deliveryId: string) =>
    sendJson("POST", `${endpointPath(orgId, id)}/deliveries/${encodeURIComponent(deliveryId)}/redeliver`, undefined, webhookDeliveryResponseSchema),
};

// ---- Reports: CSV exports and settlements --------------------------------------------

export const reportsApi = {
  listExports: (orgId: string) => getJson(`${orgPath(orgId)}/exports`, exportJobListSchema),
  createExport: (orgId: string, filters: ExportFilters) =>
    sendJson("POST", `${orgPath(orgId)}/exports`, filters, exportJobResponseSchema),
  settlements: (orgId: string, from: string, to: string) =>
    getJson(`${orgPath(orgId)}/settlements?${new URLSearchParams({ from, to })}`, settlementsResponseSchema),

  /** Streams the CSV through with its download headers; the API authorises this request. */
  async download(orgId: string, exportId: string): Promise<Response> {
    const res = await request(`${orgPath(orgId)}/exports/${encodeURIComponent(exportId)}/download`, {
      headers: await authHeader(),
      // A large file may take longer than the usual API timeout to stream.
      timeout: false,
    });
    if (!res.ok) throw await toUpstreamError(res);
    const headers = new Headers({ "cache-control": "private, no-store", "x-content-type-options": "nosniff" });
    for (const h of ["content-type", "content-disposition", "content-length"]) {
      const v = res.headers.get(h);
      if (v) headers.set(h, v);
    }
    return new Response(res.body, { status: 200, headers });
  },
};

export async function decidePayout(orgId: string, payoutId: string, action: PayoutAction, body: unknown) {
  return (await postJson(`${payoutPath(orgId, payoutId)}/${action}`, body, payoutResponseSchema)).data;
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
      { error: err.code, ...(err.detail ? { message: err.detail } : {}) },
      { status: err.status, headers: err.retryAfter ? { "retry-after": err.retryAfter } : {} },
    );
  }
  await log.error("unhandled error in route handler", { err });
  return Response.json({ error: "internal_error" }, { status: 500 });
}
