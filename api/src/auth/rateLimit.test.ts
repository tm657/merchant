import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { deadRedis, fakeClock, makeTestApp, makeTestRedis, PASSWORD } from "../test/helpers.js";
import { AttemptLimiter } from "./rateLimit.js";

const MINUTE = 60_000;

describe("AttemptLimiter", () => {
  async function setup() {
    const clock = fakeClock();
    const { redis, prefix } = await makeTestRedis();
    const limiter = new AttemptLimiter(redis, "t", { max: 3, windowMs: 10 * MINUTE, lockoutMs: 5 * MINUTE }, clock.now, prefix);
    return { clock, redis, prefix, limiter };
  }

  it("locks a key after max attempts, then unlocks after the lockout", async () => {
    const { clock, limiter } = await setup();
    await limiter.hit("k");
    await limiter.hit("k");
    assert.equal(await limiter.retryAfterMs("k"), 0);
    await limiter.hit("k");
    assert.equal(await limiter.retryAfterMs("k"), 5 * MINUTE);
    assert.equal(await limiter.retryAfterMs("other"), 0, "keys are independent");
    clock.advance(5 * MINUTE);
    assert.equal(await limiter.retryAfterMs("k"), 0);
  });

  it("forgets attempts outside the window", async () => {
    const { clock, limiter } = await setup();
    await limiter.hit("k");
    await limiter.hit("k");
    clock.advance(10 * MINUTE);
    await limiter.hit("k");
    assert.equal(await limiter.retryAfterMs("k"), 0);
  });

  it("reset clears a key", async () => {
    const { limiter } = await setup();
    for (let i = 0; i < 3; i++) await limiter.hit("k");
    await limiter.reset("k");
    assert.equal(await limiter.retryAfterMs("k"), 0);
  });

  it("is shared: a lockout set through one connection holds for another", async () => {
    const { clock, prefix, limiter } = await setup();
    const other = await makeTestRedis(prefix);
    const elsewhere = new AttemptLimiter(other.redis, "t", { max: 3, windowMs: 10 * MINUTE, lockoutMs: 5 * MINUTE }, clock.now, prefix);
    for (let i = 0; i < 3; i++) await limiter.hit("k");
    assert.equal(await elsewhere.retryAfterMs("k"), 5 * MINUTE);
  });

  it("stores only a hash of the key, with an expiry", async () => {
    const { redis, prefix, limiter } = await setup();
    await limiter.hit("someone@example.com");
    const keys = await redis.keys(`${prefix}*`);
    assert.equal(keys.length, 1);
    assert.doesNotMatch(keys[0]!, /someone/);
    const ttl = await redis.pttl(keys[0]!);
    assert.ok(ttl > 0 && ttl <= 10 * MINUTE, `ttl ${ttl}`);
  });
});

describe("rate limiter with Redis down", () => {
  it("login and register fail closed with 503", async () => {
    const t = await makeTestApp(fakeClock(), { redisClients: deadRedis() });
    const login = await t.login("admin@test.com", PASSWORD);
    assert.equal(login.statusCode, 503);
    assert.deepEqual(login.json(), { error: "service_unavailable" });
    const register = await t.app.inject({
      method: "POST",
      url: "/auth/register",
      payload: { email: "new@test.com", name: "N", password: "a long enough password" },
    });
    assert.equal(register.statusCode, 503);
    const { rowCount } = await t.db.query("SELECT 1 FROM users WHERE email = 'new@test.com'");
    assert.equal(rowCount, 0, "nothing was registered");
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
