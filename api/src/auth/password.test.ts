import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { hashPassword, verifyAgainstDummy, verifyPassword } from "./password.js";

describe("password hashing", () => {
  it("produces an argon2id hash that verifies the right password only", async () => {
    const hash = await hashPassword("a long enough password");
    assert.match(hash, /^\$argon2id\$/);
    assert.equal(await verifyPassword(hash, "a long enough password"), true);
    assert.equal(await verifyPassword(hash, "a long enough passworD"), false);
    assert.equal(await verifyPassword(hash, ""), false);
  });

  it("salts each hash, so the same password hashes differently", async () => {
    const [a, b] = await Promise.all([hashPassword("same password!!"), hashPassword("same password!!")]);
    assert.notEqual(a, b);
    assert.equal(await verifyPassword(a, "same password!!"), true);
    assert.equal(await verifyPassword(b, "same password!!"), true);
  });

  it("never stores the password in the hash", async () => {
    const hash = await hashPassword("visible-secret-123");
    assert.ok(!hash.includes("visible-secret-123"));
  });

  it("treats a malformed hash as a mismatch instead of throwing", async () => {
    assert.equal(await verifyPassword("not-a-hash", "anything"), false);
  });

  it("dummy verification always fails", async () => {
    assert.equal(await verifyAgainstDummy("not-a-real-password-used-for-timing-only"), false);
  });
});
