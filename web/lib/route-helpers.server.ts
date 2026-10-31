import "server-only";
import type { z } from "zod";

/** 400 with the zod issues, the same shape the API uses. */
export function invalidRequest(error: z.ZodError, code = "invalid_request"): Response {
  return Response.json(
    { error: code, issues: error.issues.map((i) => ({ path: i.path.join("."), message: i.message })) },
    { status: 400 },
  );
}
