import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { makeTestApp } from "../test/helpers.js";

const MINUTE = 60_000;

describe("org routes: 401 vs 403", () => {
  for (const path of ["transactions", "balances", "events"]) {
    it(`/orgs/:orgId/${path} returns 401 without a valid session`, async () => {
      const t = await makeTestApp();
      assert.equal((await t.get(`/orgs/org_1/${path}`)).statusCode, 401);
      assert.equal((await t.get(`/orgs/org_1/${path}`, "A".repeat(43))).statusCode, 401);
    });

    it(`/orgs/:orgId/${path} returns 403 for a signed-in non-member`, async () => {
      const t = await makeTestApp();
      const token = await t.tokenFor("loner@test.com");
      const res = await t.get(`/orgs/org_1/${path}`, token);
      assert.equal(res.statusCode, 403);
      assert.deepEqual(res.json(), { error: "forbidden" });
    });
  }

  it("returns 403 (not 404) for an org that doesn't exist, so orgs can't be enumerated", async () => {
    const t = await makeTestApp();
    const token = await t.tokenFor("admin@test.com");
    assert.equal((await t.get("/orgs/org_999/transactions", token)).statusCode, 403);
  });

  it("lets members in, and only to their own orgs", async () => {
    const t = await makeTestApp();
    const admin = await t.tokenFor("admin@test.com");
    assert.equal((await t.get("/orgs/org_1/transactions", admin)).statusCode, 200);
    assert.equal((await t.get("/orgs/org_2/transactions", admin)).statusCode, 403);

    const multi = await t.tokenFor("multi@test.com");
    assert.equal((await t.get("/orgs/org_1/balances", multi)).statusCode, 200);
    assert.equal((await t.get("/orgs/org_2/transactions", multi)).statusCode, 200);
    assert.equal((await t.get("/orgs/org_3/transactions", multi)).statusCode, 403);
  });

  it("enforces role permissions: support can read transactions but not balances", async () => {
    const t = await makeTestApp();
    const support = await t.tokenFor("support@test.com");
    assert.equal((await t.get("/orgs/org_1/transactions", support)).statusCode, 200);
    assert.equal((await t.get("/orgs/org_1/balances", support)).statusCode, 403);
  });

  it("returns 401 once the session has idled out, and after logout", async () => {
    const t = await makeTestApp();
    const token = await t.tokenFor("admin@test.com");
    t.clock.advance(31 * MINUTE);
    assert.equal((await t.get("/orgs/org_1/transactions", token)).statusCode, 401);

    const fresh = await t.tokenFor("admin@test.com");
    const logout = await t.app.inject({ method: "POST", url: "/auth/logout", headers: { authorization: `Bearer ${fresh}` } });
    assert.equal(logout.statusCode, 204);
    assert.equal((await t.get("/orgs/org_1/transactions", fresh)).statusCode, 401);
  });
});

describe("/me", () => {
  it("returns the user and all memberships with roles", async () => {
    const t = await makeTestApp();
    const res = await t.get("/me", await t.tokenFor("multi@test.com"));
    assert.equal(res.statusCode, 200);
    const body = res.json() as { user: { email: string }; memberships: { orgId: string; role: string }[] };
    assert.equal(body.user.email, "multi@test.com");
    assert.deepEqual(
      body.memberships.map((m) => [m.orgId, m.role]),
      [["org_1", "finance"], ["org_2", "admin"]],
    );
    assert.ok(!JSON.stringify(body).includes("password"), "never exposes the password hash");
  });

  it("returns 401 without a session", async () => {
    const t = await makeTestApp();
    assert.equal((await t.get("/me")).statusCode, 401);
  });
});
