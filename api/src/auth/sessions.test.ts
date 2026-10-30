import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { openDb } from "../db.js";
import { fakeClock } from "../test/helpers.js";
import { ABSOLUTE_LIFETIME_MS, createSessionStore, hashToken, IDLE_TIMEOUT_MS } from "./sessions.js";

const MINUTE = 60_000;

function setup() {
  const db = openDb(":memory:");
  db.prepare("INSERT INTO users (id, email, name, password_hash, created_at) VALUES ('u1', 'a@b.co', 'A', 'x', '2026-01-01')").run();
  const clock = fakeClock();
  const sessions = createSessionStore(db, clock.now);
  const count = () => (db.prepare("SELECT COUNT(*) AS n FROM sessions").get() as { n: number }).n;
  return { db, clock, sessions, count };
}

describe("sessions", () => {
  it("returns a 32-byte token and stores only its SHA-256 hash", () => {
    const { db, sessions } = setup();
    const { token } = sessions.create("u1", "test-agent");
    assert.equal(Buffer.from(token, "base64url").length, 32);

    const row = db.prepare("SELECT token_hash, user_agent FROM sessions").get() as { token_hash: string; user_agent: string };
    assert.equal(row.token_hash, hashToken(token));
    assert.notEqual(row.token_hash, token);
    assert.equal(row.user_agent, "test-agent");
    assert.equal(sessions.validate(token)?.userId, "u1");
  });

  it("rejects unknown, malformed and missing tokens", () => {
    const { sessions } = setup();
    sessions.create("u1", null);
    assert.equal(sessions.validate("A".repeat(43)), null);
    assert.equal(sessions.validate("short"), null);
    assert.equal(sessions.validate(null), null);
  });

  it("expires after 30 minutes without activity", () => {
    const { clock, sessions, count } = setup();
    const { token } = sessions.create("u1", null);

    clock.advance(IDLE_TIMEOUT_MS - MINUTE);
    assert.ok(sessions.validate(token), "still valid just before the idle timeout");

    // That request counted as activity, so the idle timer restarted.
    clock.advance(IDLE_TIMEOUT_MS - MINUTE);
    assert.ok(sessions.validate(token), "activity extends the session");

    clock.advance(IDLE_TIMEOUT_MS);
    assert.equal(sessions.validate(token), null, "expired after 30 idle minutes");
    assert.equal(count(), 0, "expired session is deleted");
  });

  it("checks with touch: false do not count as activity", () => {
    const { clock, sessions } = setup();
    const { token } = sessions.create("u1", null);
    clock.advance(20 * MINUTE);
    assert.ok(sessions.validate(token, { touch: false }));
    clock.advance(11 * MINUTE);
    assert.equal(sessions.validate(token), null);
  });

  it("expires after 8 hours even with constant activity", () => {
    const { clock, sessions } = setup();
    const { token, expiresAt } = sessions.create("u1", null);
    assert.equal(Date.parse(expiresAt), clock.now() + ABSOLUTE_LIFETIME_MS);

    // Active every 20 minutes for just under 8 hours.
    for (let t = 20 * MINUTE; t < ABSOLUTE_LIFETIME_MS; t += 20 * MINUTE) {
      clock.advance(20 * MINUTE);
      assert.ok(sessions.validate(token), `valid at ${t / MINUTE} min`);
    }
    clock.advance(20 * MINUTE);
    assert.equal(sessions.validate(token), null, "expired at the absolute lifetime");
  });

  it("rotates away the browser's old session on a new login", () => {
    const { sessions, count } = setup();
    const first = sessions.create("u1", null);
    const second = sessions.create("u1", null, first.token);
    assert.equal(sessions.validate(first.token), null);
    assert.ok(sessions.validate(second.token));
    assert.equal(count(), 1);
  });

  it("destroy ends the session", () => {
    const { sessions } = setup();
    const { token } = sessions.create("u1", null);
    sessions.destroy(token);
    assert.equal(sessions.validate(token), null);
  });
});
