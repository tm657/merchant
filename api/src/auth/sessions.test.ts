import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { fakeClock, makeTestDb } from "../test/helpers.js";
import { ABSOLUTE_LIFETIME_MS, createSessionStore, hashToken, IDLE_TIMEOUT_MS } from "./sessions.js";

const MINUTE = 60_000;

async function setup() {
  const { db } = await makeTestDb();
  await db.query("INSERT INTO users (id, email, name, password_hash, created_at) VALUES ('u1', 'a@b.co', 'A', 'x', '2026-01-01')");
  const clock = fakeClock();
  const sessions = createSessionStore(db, clock.now);
  const count = async () => (await db.query<{ n: number }>("SELECT COUNT(*) AS n FROM sessions")).rows[0]!.n;
  return { db, clock, sessions, count };
}

describe("sessions", () => {
  it("returns a 32-byte token and stores only its SHA-256 hash", async () => {
    const { db, sessions } = await setup();
    const { token } = await sessions.create("u1", "test-agent");
    assert.equal(Buffer.from(token, "base64url").length, 32);

    const row = (await db.query<{ token_hash: string; user_agent: string }>("SELECT token_hash, user_agent FROM sessions")).rows[0]!;
    assert.equal(row.token_hash, hashToken(token));
    assert.notEqual(row.token_hash, token);
    assert.equal(row.user_agent, "test-agent");
    assert.equal((await sessions.validate(token))?.userId, "u1");
  });

  it("rejects unknown, malformed and missing tokens", async () => {
    const { sessions } = await setup();
    await sessions.create("u1", null);
    assert.equal(await sessions.validate("A".repeat(43)), null);
    assert.equal(await sessions.validate("short"), null);
    assert.equal(await sessions.validate(null), null);
  });

  it("expires after 30 minutes without activity", async () => {
    const { clock, sessions, count } = await setup();
    const { token } = await sessions.create("u1", null);

    clock.advance(IDLE_TIMEOUT_MS - MINUTE);
    assert.ok(await sessions.validate(token), "still valid just before the idle timeout");

    // That request counted as activity, so the idle timer restarted.
    clock.advance(IDLE_TIMEOUT_MS - MINUTE);
    assert.ok(await sessions.validate(token), "activity extends the session");

    clock.advance(IDLE_TIMEOUT_MS);
    assert.equal(await sessions.validate(token), null, "expired after 30 idle minutes");
    assert.equal(await count(), 0, "expired session is deleted");
  });

  it("checks with touch: false do not count as activity", async () => {
    const { clock, sessions } = await setup();
    const { token } = await sessions.create("u1", null);
    clock.advance(20 * MINUTE);
    assert.ok(await sessions.validate(token, { touch: false }));
    clock.advance(11 * MINUTE);
    assert.equal(await sessions.validate(token), null);
  });

  it("expires after 8 hours even with constant activity", async () => {
    const { clock, sessions } = await setup();
    const { token, expiresAt } = await sessions.create("u1", null);
    assert.equal(Date.parse(expiresAt), clock.now() + ABSOLUTE_LIFETIME_MS);

    // Active every 20 minutes for just under 8 hours.
    for (let t = 20 * MINUTE; t < ABSOLUTE_LIFETIME_MS; t += 20 * MINUTE) {
      clock.advance(20 * MINUTE);
      assert.ok(await sessions.validate(token), `valid at ${t / MINUTE} min`);
    }
    clock.advance(20 * MINUTE);
    assert.equal(await sessions.validate(token), null, "expired at the absolute lifetime");
  });

  it("rotates away the browser's old session on a new login", async () => {
    const { sessions, count } = await setup();
    const first = await sessions.create("u1", null);
    const second = await sessions.create("u1", null, first.token);
    assert.equal(await sessions.validate(first.token), null);
    assert.ok(await sessions.validate(second.token));
    assert.equal(await count(), 1);
  });

  it("destroy ends the session", async () => {
    const { sessions } = await setup();
    const { token } = await sessions.create("u1", null);
    await sessions.destroy(token);
    assert.equal(await sessions.validate(token), null);
  });
});
