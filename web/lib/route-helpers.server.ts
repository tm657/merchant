import "server-only";
import type { z } from "zod";

/** 400 with the zod issues, the same shape the API uses. */
export function invalidRequest(error: z.ZodError, code = "invalid_request"): Response {
  return Response.json(
    { error: code, issues: error.issues.map((i) => ({ path: i.path.join("."), message: i.message })) },
    { status: 400 },
  );
}

/** The largest JSON body any BFF route accepts. Every real one is well under 4 KB. */
export const MAX_JSON_BODY_BYTES = 16 * 1024;

export type JsonBody = { ok: true; value: unknown } | { ok: false; response: Response };

const tooLarge = () =>
  Response.json({ error: "payload_too_large", message: `Request bodies are limited to ${MAX_JSON_BODY_BYTES} bytes.` }, { status: 413 });

/**
 * Reads a JSON body of at most `maxBytes`, without buffering more than that: a declared
 * Content-Length over the cap is refused up front, and the stream is cut off as soon as
 * it passes the cap (Content-Length can be missing or wrong). Unparseable JSON, or no
 * body, comes back as `fallback`, so each route keeps its own validation errors.
 */
export async function readJsonBody(req: Request, { maxBytes = MAX_JSON_BODY_BYTES, fallback = null as unknown } = {}): Promise<JsonBody> {
  const declared = Number(req.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) return { ok: false, response: tooLarge() };
  if (!req.body) return { ok: true, value: fallback };

  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel();
      return { ok: false, response: tooLarge() };
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const c of chunks) {
    bytes.set(c, offset);
    offset += c.byteLength;
  }
  try {
    return { ok: true, value: size === 0 ? fallback : JSON.parse(new TextDecoder().decode(bytes)) };
  } catch {
    return { ok: true, value: fallback };
  }
}
