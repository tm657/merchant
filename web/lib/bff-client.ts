import type { z } from "zod";
import { errorBodySchema } from "@mini-payments/shared";

/** An error response from our own BFF, as seen by browser code. */
export class BffError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
    this.name = "BffError";
  }
}

/** GET a BFF route and validate the response. Throws BffError on non-2xx. */
export async function bffGet<T>(url: string, schema: z.ZodType<T>, signal?: AbortSignal): Promise<T> {
  const res = await fetch(url, { signal, credentials: "same-origin" });
  const body: unknown = await res.json().catch(() => null);
  if (!res.ok) throw new BffError(res.status, errorBodySchema.safeParse(body).data?.error ?? "unknown_error");
  return schema.parse(body);
}

/** POST JSON to a BFF route. Returns status and parsed error code (if any). */
export async function bffPost(url: string, payload?: unknown): Promise<{ ok: boolean; status: number; code?: string; retryAfter?: number }> {
  const res = await fetch(url, {
    method: "POST",
    credentials: "same-origin",
    headers: payload === undefined ? {} : { "content-type": "application/json" },
    body: payload === undefined ? undefined : JSON.stringify(payload),
  });
  const body: unknown = await res.json().catch(() => null);
  const retryAfter = Number(res.headers.get("retry-after")) || undefined;
  return { ok: res.ok, status: res.status, code: errorBodySchema.safeParse(body).data?.error, retryAfter };
}

/** Only same-app paths, so ?next= can't be used as an open redirect. */
export function safeNextPath(next: string | null | undefined): string {
  if (!next || !next.startsWith("/") || next.startsWith("//") || next.startsWith("/\\") || next.startsWith("/api")) {
    return "/";
  }
  return next;
}
