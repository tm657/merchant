import "server-only";
import type { z } from "zod";
import {
  balancesSchema,
  errorBodySchema,
  transactionsPageSchema,
  type Balances,
  type TransactionsPage,
} from "./schemas";

const TIMEOUT_MS = 5000;

/** An error talking to the upstream API, already mapped to the status the BFF should return. */
export class UpstreamError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
    this.name = "UpstreamError";
  }
}

function apiUrl(): string {
  const url = process.env.API_URL;
  if (!url) throw new UpstreamError(500, "api_url_not_configured");
  return url.replace(/\/+$/, "");
}

async function getJson<T>(path: string, schema: z.ZodType<T>): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${apiUrl()}${path}`, {
      cache: "no-store",
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    if (err instanceof UpstreamError) throw err;
    if (err instanceof DOMException && err.name === "TimeoutError") {
      throw new UpstreamError(504, "upstream_timeout");
    }
    throw new UpstreamError(502, "upstream_unavailable");
  }

  const body: unknown = await res.json().catch(() => null);

  if (!res.ok) {
    const code = errorBodySchema.safeParse(body).data?.error;
    // Client mistakes pass through with the upstream code; anything else is a bad gateway.
    if (res.status === 400) throw new UpstreamError(400, code ?? "invalid_request");
    if (res.status === 404) throw new UpstreamError(404, code ?? "not_found");
    throw new UpstreamError(502, "upstream_error");
  }

  const parsed = schema.safeParse(body);
  if (!parsed.success) throw new UpstreamError(502, "bad_upstream_response");
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

/** Turns any error into a clean JSON response for a route handler. */
export function errorResponse(err: unknown): Response {
  if (err instanceof UpstreamError) {
    return Response.json({ error: err.code }, { status: err.status });
  }
  console.error(err);
  return Response.json({ error: "internal_error" }, { status: 500 });
}
