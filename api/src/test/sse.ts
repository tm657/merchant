import assert from "node:assert/strict";

/** Opens an SSE stream on a listening app and collects the events it receives. */
export async function openStream(baseUrl: string, token: string, orgId = "org_1") {
  const ctrl = new AbortController();
  const res = await fetch(`${baseUrl}/orgs/${orgId}/events`, { headers: { authorization: `Bearer ${token}` }, signal: ctrl.signal });
  assert.equal(res.status, 200);
  const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  return {
    /** Resolves with the next `event: <name>` frame's data. */
    async next(name: string, timeoutMs = 3000): Promise<unknown> {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const match = buffer.match(new RegExp(`event: ${name}\\ndata: (.*)\\n\\n`));
        if (match) {
          buffer = buffer.slice(match.index! + match[0].length);
          return JSON.parse(match[1]!);
        }
        if (Date.now() > deadline) throw new Error(`no ${name} event within ${timeoutMs} ms`);
        const { value, done } = await Promise.race([
          reader.read(),
          new Promise<never>((_, reject) => setTimeout(() => reject(new Error("read timed out")), timeoutMs)),
        ]);
        if (done) throw new Error("stream ended");
        buffer += value;
      }
    },
    close: () => ctrl.abort(),
  };
}
