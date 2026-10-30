import type { NextRequest } from "next/server";
import { errorResponse, openEventStream } from "@/lib/api.server";
import { orgIdSchema } from "@/lib/schemas";

// No `export const dynamic = "force-dynamic"`: it fails the build with cacheComponents on.
// This handler reads the request, so it already runs on every request.

export async function GET(req: NextRequest, ctx: RouteContext<"/api/orgs/[orgId]/events">) {
  const orgId = orgIdSchema.safeParse((await ctx.params).orgId);
  if (!orgId.success) return Response.json({ error: "invalid_request" }, { status: 400 });

  try {
    // req.signal aborts when the browser disconnects, which closes the upstream stream too.
    const body = await openEventStream(orgId.data, req.signal);
    return new Response(body, {
      headers: {
        "content-type": "text/event-stream; charset=utf-8",
        // no-transform keeps compression from buffering the stream.
        "cache-control": "no-cache, no-transform",
        "x-accel-buffering": "no",
      },
    });
  } catch (err) {
    return errorResponse(err);
  }
}
