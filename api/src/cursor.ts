import { DIRS, type SortKey } from "@mini-payments/shared";
import { z } from "zod";

export type Sort = SortKey;

// The cursor holds the last row's sort value and id, plus the sort and direction it was
// made for. That way a cursor reused with a different sort is rejected rather than
// silently returning the wrong page.
const cursorSchema = z.discriminatedUnion("s", [
  z.object({ s: z.literal("createdAt"), d: z.enum(DIRS), v: z.iso.datetime(), id: z.string().min(1) }),
  z.object({ s: z.literal("amount"), d: z.enum(DIRS), v: z.number().int(), id: z.string().min(1) }),
]);
export type Cursor = z.infer<typeof cursorSchema>;

export function encodeCursor(cursor: Cursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

/** Returns the decoded cursor, or null if it is malformed. */
export function decodeCursor(raw: string): Cursor | null {
  try {
    const json: unknown = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
    const parsed = cursorSchema.safeParse(json);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

// Pay-outs are always listed newest first, so their cursor is just the last row's position.
const payoutCursorSchema = z.object({ v: z.iso.datetime(), id: z.string().min(1) });
export type PayoutCursor = z.infer<typeof payoutCursorSchema>;

export function encodePayoutCursor(cursor: PayoutCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

export function decodePayoutCursor(raw: string): PayoutCursor | null {
  try {
    const parsed = payoutCursorSchema.safeParse(JSON.parse(Buffer.from(raw, "base64url").toString("utf8")));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
