import "server-only";
import { REQUEST_ID_HEADER } from "@mini-payments/shared";
import { headers } from "next/headers";

type Level = "info" | "warn" | "error";

/** The ID proxy.ts put on this request. The same ID is forwarded to the API. */
export async function getRequestId(): Promise<string | undefined> {
  try {
    return (await headers()).get(REQUEST_ID_HEADER) ?? undefined;
  } catch {
    // Outside a request (e.g. at startup) there are no headers.
    return undefined;
  }
}

function serializeError(err: unknown) {
  return err instanceof Error ? { type: err.name, message: err.message, stack: err.stack } : err;
}

/** One JSON line per call, always with the request ID, matching the API's log format. */
async function write(level: Level, msg: string, fields: Record<string, unknown> = {}) {
  const { err, ...rest } = fields;
  const line = JSON.stringify({
    level,
    time: Date.now(),
    service: "web",
    requestId: await getRequestId(),
    msg,
    ...rest,
    ...(err === undefined ? {} : { err: serializeError(err) }),
  });
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

export const log = {
  info: (msg: string, fields?: Record<string, unknown>) => write("info", msg, fields),
  warn: (msg: string, fields?: Record<string, unknown>) => write("warn", msg, fields),
  error: (msg: string, fields?: Record<string, unknown>) => write("error", msg, fields),
};
