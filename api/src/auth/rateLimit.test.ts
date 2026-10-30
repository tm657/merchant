import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { fakeClock, makeTestApp, PASSWORD } from "../test/helpers.js";
import { AttemptLimiter } from "./rateLimit.js";

const MINUTE = 60_000;

describe("AttemptLimiter", () => {
  it("locks a key after max attempts, then unlocks after the lockout", () => {
    const clock = fakeClock();
    const limiter = new AttemptLimiter({ max: 3, windowMs: 10 * MINUTE, lockoutMs: 5 * MINUTE }, clock.now);
    limiter.hit("k");
    limiter.hit("k");
    assert.equal(limiter.retryAfterMs("k"), 0);
    limiter.hit("k");
    assert.equal(limiter.retryAfterMs("k"), 5 * MINUTE);
    assert.equal(limiter.retryAfterMs("other"), 0, "keys are independent");
    clock.advance(5 * MINUTE);
    assert.equal(limiter.retryAfterMs("k"), 0);
  });

  it("forgets attempts outside the window", () => {
    const clock = fakeClock();
    const limiter = new AttemptLimiter({ max: 3, windowMs: 10 * MINUTE, lockoutMs: 5 * MINUTE }, clock.now);
    limiter.hit("k");
    limiter.hit("k");
    clock.advance(10 * MINUTE);
    limiter.hit("k");
    assert.equal(limiter.retryAfterMs("k"), 0);
  });
});

describe("login rate limiting", () => {
  it("locks an email after 5 failures, even for the right password, then recovers", async () => {
    const t = await makeTestApp();
    for (let i = 0; i < 5; i++) {
      assert.equal((await t.login("admin@test.com", "wrong password")).statusCode, 401);
    }
    const locked = await t.login("admin@test.com", PASSWORD);
    assert.equal(locked.statusCode, 429);
    assert.deepEqual(locked.json(), { error: "too_many_attempts" });
    assert.equal(locked.headers["retry-after"], "300");

    t.clock.advance(5 * MINUTE);
    assert.equal((await t.login("admin@test.com", PASSWORD)).statusCode, 200);
  });

  it("counts failures per email case-insensitively", async () => {
    const t = await makeTestApp();
    for (const email of ["ADMIN@test.com", "Admin@Test.com", " admin@test.com", "admin@TEST.com", "admin@test.com"]) {
      await t.login(email, "wrong password");
    }
    assert.equal((await t.login("admin@test.com")).statusCode, 429);
  });

  it("locks an IP after 20 failures across many emails", async () => {
    const t = await makeTestApp();
    for (let i = 0; i < 20; i++) await t.login(`nobody${i}@test.com`, "wrong", "10.9.9.9");
    assert.equal((await t.login("admin@test.com", PASSWORD, "10.9.9.9")).statusCode, 429);
    assert.equal((await t.login("admin@test.com", PASSWORD, "10.1.1.1")).statusCode, 200, "other IPs unaffected");
  });

  it("uses the forwarded client IP only when the request comes from loopback (the BFF)", async () => {
    const t = await makeTestApp();
    const viaBff = (ip: string) =>
      t.app.inject({
        method: "POST",
        url: "/auth/login",
        payload: { email: `x${Math.random()}@test.com`, password: "wrong" },
        remoteAddress: "127.0.0.1",
        headers: { "x-forwarded-for": ip },
      });
    for (let i = 0; i < 20; i++) await viaBff("203.0.113.5");
    assert.equal((await viaBff("203.0.113.5")).statusCode, 429);
    assert.equal((await viaBff("203.0.113.6")).statusCode, 401, "a different browser IP behind the BFF is not locked");
  });

  it("limits registrations per IP", async () => {
    const t = await makeTestApp();
    const register = (i: number) =>
      t.app.inject({
        method: "POST",
        url: "/auth/register",
        payload: { email: `new${i}@test.com`, name: "N", password: "a long enough password" },
        remoteAddress: "10.2.2.2",
      });
    for (let i = 0; i < 5; i++) assert.equal((await register(i)).statusCode, 202);
    assert.equal((await register(99)).statusCode, 429);
  });
});

describe("generic auth errors", () => {
  it("answers the same for an unknown email and a wrong password", async () => {
    const t = await makeTestApp();
    const unknown = await t.login("ghost@test.com", "whatever password");
    const wrong = await t.login("admin@test.com", "whatever password");
    assert.equal(unknown.statusCode, 401);
    assert.equal(wrong.statusCode, 401);
    assert.deepEqual(unknown.json(), wrong.json());
  });

  it("answers the same for registering a new and an existing email", async () => {
    const t = await makeTestApp();
    const register = (email: string) =>
      t.app.inject({ method: "POST", url: "/auth/register", payload: { email, name: "X", password: "another long password" } });
    const fresh = await register("fresh@test.com");
    const existing = await register("admin@test.com");
    assert.equal(fresh.statusCode, existing.statusCode);
    assert.deepEqual(fresh.json(), existing.json());
    // And the existing account's password was not changed.
    assert.equal((await t.login("admin@test.com", PASSWORD)).statusCode, 200);
  });
});
