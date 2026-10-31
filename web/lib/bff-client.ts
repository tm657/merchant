import { z } from "zod";
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

export type BffResult<T> =
  | { ok: true; status: number; data: T; headers: Headers }
  /** status 0: the request never got an answer (network error), so the outcome is unknown. */
  | { ok: false; status: number; code: string; retryAfter?: number; issues?: { path: string; message: string }[] };

const issuesSchema = z.object({ issues: z.array(z.object({ path: z.string(), message: z.string() })) });

/** POST JSON to a BFF route and validate the answer. Never throws for HTTP or network errors. */
export async function bffPostJson<T>(
  url: string,
  payload: unknown,
  schema: z.ZodType<T>,
  headers: Record<string, string> = {},
): Promise<BffResult<T>> {
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(payload),
    });
  } catch {
    return { ok: false, status: 0, code: "network" };
  }
  const body: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    return {
      ok: false,
      status: res.status,
      code: errorBodySchema.safeParse(body).data?.error ?? "unknown_error",
      retryAfter: Number(res.headers.get("retry-after")) || undefined,
      issues: issuesSchema.safeParse(body).data?.issues,
    };
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) return { ok: false, status: res.status, code: "bad_response" };
  return { ok: true, status: res.status, data: parsed.data, headers: res.headers };
}
