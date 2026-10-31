import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { createDb } from "./db.js";
import { deadRedis, fakeClock, makeTestApp } from "./test/helpers.js";

describe("health", () => {
  it("/healthz is 200 without touching dependencies", async () => {
    const t = await makeTestApp(fakeClock(), { redisClients: deadRedis() });
    const res = await t.get("/healthz");
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json(), { status: "ok" });
  });

  it("/readyz is 200 when Postgres and Redis both answer", async () => {
    const t = await makeTestApp();
    const res = await t.get("/readyz");
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json(), { status: "ok", checks: { postgres: "ok", redis: "ok" } });
  });

  it("/readyz is 503 when Redis is down", async () => {
    const t = await makeTestApp(fakeClock(), { redisClients: deadRedis() });
    const res = await t.get("/readyz");
    assert.equal(res.statusCode, 503);
    assert.deepEqual(res.json(), { status: "unavailable", checks: { postgres: "ok", redis: "error" } });
  });

  it("/readyz is 503 when Postgres is down, without error details", async () => {
    const deadPg = createDb("postgres://nobody:secret@127.0.0.1:1/none");
    const t = await makeTestApp(fakeClock(), { readiness: { postgres: () => deadPg.query("SELECT 1") } });
    const res = await t.get("/readyz");
    await deadPg.end();
    assert.equal(res.statusCode, 503);
    assert.deepEqual(res.json(), { status: "unavailable", checks: { postgres: "error", redis: "ok" } });
    assert.doesNotMatch(res.body, /secret|127\.0\.0\.1/);
  });
});

describe("x-request-id", () => {
  it("generates one when the caller sends none", async () => {
    const res = await (await makeTestApp()).get("/healthz");
    assert.match(String(res.headers["x-request-id"]), /^[0-9a-f-]{36}$/);
  });

  it("reuses a well-formed incoming id", async () => {
    const t = await makeTestApp();
    const res = await t.app.inject({ method: "GET", url: "/healthz", headers: { "x-request-id": "bff-abc.123" } });
    assert.equal(res.headers["x-request-id"], "bff-abc.123");
  });

  it("replaces a malformed incoming id", async () => {
    const t = await makeTestApp();
    const res = await t.app.inject({ method: "GET", url: "/healthz", headers: { "x-request-id": "bad id\nwith newline" } });
    assert.match(String(res.headers["x-request-id"]), /^[0-9a-f-]{36}$/);
  });

  it("is on every request-scoped log line", async () => {
    const lines: Record<string, unknown>[] = [];
    const stream = { write: (line: string) => void lines.push(JSON.parse(line) as Record<string, unknown>) };
    const t = await makeTestApp(fakeClock(), { logger: { level: "info", stream } });
    await t.app.inject({ method: "GET", url: "/me", headers: { "x-request-id": "trace-1" } });
    const requestLines = lines.filter((l) => "req" in l || "res" in l);
    assert.ok(requestLines.length >= 2);
    for (const line of requestLines) assert.equal(line.requestId, "trace-1");
  });
});
