import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildApp } from "./app.js";
import { openDb } from "./db.js";

function appWith(readiness: Parameters<typeof buildApp>[0]["readiness"] = {}) {
  return buildApp({ db: openDb(":memory:"), readiness }).app;
}

describe("health", () => {
  it("/healthz is 200 without touching dependencies", async () => {
    const app = appWith({ postgres: () => Promise.reject(new Error("down")) });
    const res = await app.inject({ method: "GET", url: "/healthz" });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json(), { status: "ok" });
  });

  it("/readyz is 200 when every check passes", async () => {
    const app = appWith({ postgres: async () => {}, redis: async () => "PONG" });
    const res = await app.inject({ method: "GET", url: "/readyz" });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json(), { status: "ok", checks: { sqlite: "ok", postgres: "ok", redis: "ok" } });
  });

  it("/readyz is 503 and names the failing check, without error details", async () => {
    const app = appWith({ postgres: async () => {}, redis: () => Promise.reject(new Error("ECONNREFUSED secret-host")) });
    const res = await app.inject({ method: "GET", url: "/readyz" });
    assert.equal(res.statusCode, 503);
    assert.deepEqual(res.json(), { status: "unavailable", checks: { sqlite: "ok", postgres: "ok", redis: "error" } });
    assert.doesNotMatch(res.body, /secret-host/);
  });
});

describe("x-request-id", () => {
  it("generates one when the caller sends none", async () => {
    const res = await appWith().inject({ method: "GET", url: "/healthz" });
    assert.match(String(res.headers["x-request-id"]), /^[0-9a-f-]{36}$/);
  });

  it("reuses a well-formed incoming id", async () => {
    const res = await appWith().inject({ method: "GET", url: "/healthz", headers: { "x-request-id": "bff-abc.123" } });
    assert.equal(res.headers["x-request-id"], "bff-abc.123");
  });

  it("replaces a malformed incoming id", async () => {
    const res = await appWith().inject({
      method: "GET",
      url: "/healthz",
      headers: { "x-request-id": "bad id\nwith newline" },
    });
    assert.match(String(res.headers["x-request-id"]), /^[0-9a-f-]{36}$/);
  });

  it("is on every request-scoped log line", async () => {
    const lines: Record<string, unknown>[] = [];
    const stream = { write: (line: string) => void lines.push(JSON.parse(line) as Record<string, unknown>) };
    const { app } = buildApp({ db: openDb(":memory:"), logger: { level: "info", stream } });
    await app.inject({ method: "GET", url: "/me", headers: { "x-request-id": "trace-1" } });
    const requestLines = lines.filter((l) => "req" in l || "res" in l);
    assert.ok(requestLines.length >= 2);
    for (const line of requestLines) assert.equal(line.requestId, "trace-1");
  });
});
