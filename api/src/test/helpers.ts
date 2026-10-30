import { buildApp } from "../app.js";
import { hashPassword } from "../auth/password.js";
import { openDb, type Role } from "../db.js";

export const PASSWORD = "correct horse battery staple";

/** A controllable clock: tests move time forward instead of waiting. */
export function fakeClock(start = Date.parse("2026-01-01T09:00:00.000Z")) {
  let now = start;
  return {
    now: () => now,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

/**
 * Fresh in-memory database and app. Users:
 *   admin@test (org_1 admin), multi@test (org_1 finance + org_2 admin),
 *   support@test (org_1 support), loner@test (no orgs).
 */
export async function makeTestApp(clock = fakeClock()) {
  const db = openDb(":memory:");
  const hash = await hashPassword(PASSWORD);
  const now = new Date(clock.now()).toISOString();

  for (const org of ["org_1", "org_2", "org_3"]) db.prepare("INSERT INTO orgs (id, name) VALUES (?, ?)").run(org, org);
  db.prepare("INSERT INTO balances (org_id, currency, available, updated_at) VALUES ('org_1', 'USD', 1000, ?)").run(now);

  const users: [id: string, email: string, memberships: [string, Role][]][] = [
    ["u_admin", "admin@test.com", [["org_1", "admin"]]],
    ["u_multi", "multi@test.com", [["org_1", "finance"], ["org_2", "admin"]]],
    ["u_support", "support@test.com", [["org_1", "support"]]],
    ["u_loner", "loner@test.com", []],
  ];
  for (const [id, email, memberships] of users) {
    db.prepare("INSERT INTO users (id, email, name, password_hash, created_at) VALUES (?, ?, ?, ?, ?)").run(
      id, email, id, hash, now,
    );
    for (const [org, role] of memberships) {
      db.prepare("INSERT INTO memberships (user_id, org_id, role) VALUES (?, ?, ?)").run(id, org, role);
    }
  }

  const { app } = buildApp({ db, clock: clock.now });

  async function login(email: string, password = PASSWORD, ip = "10.0.0.1") {
    return app.inject({ method: "POST", url: "/auth/login", payload: { email, password }, remoteAddress: ip });
  }

  async function tokenFor(email: string): Promise<string> {
    const res = await login(email);
    if (res.statusCode !== 200) throw new Error(`login failed: ${res.statusCode} ${res.body}`);
    return (res.json() as { token: string }).token;
  }

  const get = (url: string, token?: string) =>
    app.inject({ method: "GET", url, headers: token ? { authorization: `Bearer ${token}` } : {} });

  return { app, db, clock, login, tokenFor, get };
}
