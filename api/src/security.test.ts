import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { assertAppRole } from "./db.js";
import { BODY_LIMIT_BYTES } from "./security.js";
import { makeTestApp } from "./test/helpers.js";

describe("request bodies", () => {
  it("refuses bodies over the limit with 413, before any route runs", async () => {
    const t = await makeTestApp();
    const res = await t.app.inject({
      method: "POST",
      url: "/auth/login",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ email: "a@b.co", password: "x".repeat(BODY_LIMIT_BYTES) }),
    });
    assert.equal(res.statusCode, 413);
    assert.deepEqual(res.json(), { error: "payload_too_large" });
    const audited = await t.db.query("SELECT 1 FROM audit_log");
    assert.equal(audited.rowCount, 0, "the login route never ran");
  });

  it("accepts a body just under the limit", async () => {
    const t = await makeTestApp();
    const res = await t.app.inject({
      method: "POST",
      url: "/auth/login",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ email: "a@b.co", password: "x".repeat(BODY_LIMIT_BYTES - 100) }),
    });
    assert.equal(res.statusCode, 400, "parsed, then refused by validation (password too long), not by size");
  });

  it("answers malformed JSON with 400 invalid_json", async () => {
    const t = await makeTestApp();
    const res = await t.app.inject({ method: "POST", url: "/auth/login", headers: { "content-type": "application/json" }, payload: "{nope" });
    assert.equal(res.statusCode, 400);
    assert.deepEqual(res.json(), { error: "invalid_json" });
  });

  it("never sends internal error messages to the caller", async () => {
    const t = await makeTestApp();
    t.app.get("/boom", async () => {
      throw new Error("secret connection string postgres://user:pw@db");
    });
    const res = await t.get("/boom");
    assert.equal(res.statusCode, 500);
    assert.deepEqual(res.json(), { error: "internal_error" });
  });
});

describe("response headers", () => {
  const expected = {
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    "content-security-policy": "default-src 'none'; frame-ancestors 'none'",
    "x-frame-options": "DENY",
  };

  it("sets the security headers on success, error and 404 responses", async () => {
    const t = await makeTestApp();
    for (const res of [await t.get("/healthz"), await t.get("/me"), await t.get("/no-such-route")]) {
      for (const [k, v] of Object.entries(expected)) assert.equal(res.headers[k], v, `${k} on ${res.statusCode}`);
    }
  });

  it("sets them on the hijacked event stream too", async () => {
    const t = await makeTestApp(undefined);
    const token = await t.tokenFor("admin@test.com");
    const url = await t.app.listen({ port: 0, host: "127.0.0.1" });
    const ctrl = new AbortController();
    const res = await fetch(`${url}/orgs/org_1/events`, { headers: { authorization: `Bearer ${token}` }, signal: ctrl.signal });
    for (const [k, v] of Object.entries(expected)) assert.equal(res.headers.get(k), v, k);
    ctrl.abort();
  });
});

describe("CORS stays closed", () => {
  it("never sends Access-Control-* headers, for simple or preflight requests from another origin", async () => {
    const t = await makeTestApp();
    const origin = { origin: "https://evil.example" };
    const responses = [
      await t.app.inject({ method: "GET", url: "/healthz", headers: origin }),
      await t.app.inject({ method: "POST", url: "/auth/login", headers: origin, payload: {} }),
      await t.app.inject({
        method: "OPTIONS",
        url: "/auth/login",
        headers: { ...origin, "access-control-request-method": "POST", "access-control-request-headers": "content-type" },
      }),
    ];
    for (const res of responses) {
      const cors = Object.keys(res.headers).filter((h) => h.startsWith("access-control-"));
      assert.deepEqual(cors, [], `${res.statusCode}: ${cors.join(", ")}`);
    }
    assert.equal(responses[2]!.statusCode, 404, "no OPTIONS handler, so no preflight can succeed");
  });
});

describe("least-privilege database role", () => {
  it("the app role can't run DDL, create temp tables or truncate", async () => {
    const t = await makeTestApp();
    for (const sql of [
      "CREATE TABLE evil (x int)",
      "CREATE SCHEMA evil",
      "CREATE TEMP TABLE evil (x int)",
      "ALTER TABLE transactions ADD COLUMN evil int",
      "DROP TABLE transactions",
      "TRUNCATE transactions",
      "CREATE INDEX evil ON transactions (merchant)",
      "CREATE FUNCTION evil() RETURNS int LANGUAGE sql AS 'select 1'",
      "CREATE ROLE evil",
      "ALTER TABLE audit_log DISABLE TRIGGER ALL",
    ]) {
      await assert.rejects(t.db.query(sql), /permission denied|must be owner|must be|not allowed/i, sql);
    }
    // Rows are still fine.
    await t.db.query("UPDATE balances SET updated_at = updated_at");
  });

  it("passes the startup check as the app role, and refuses an over-privileged one", async () => {
    const t = await makeTestApp();
    await assertAppRole(t.db);
    await assert.rejects(assertAppRole(t.owner), (err: Error) => {
      assert.match(err.message, /is a superuser/);
      assert.match(err.message, /owns /);
      return true;
    });
  });
});
