import type { FastifyInstance, FastifyReply } from "fastify";
import { randomUUID } from "node:crypto";
import { bearerToken, type AuthContext } from "../auth/context.js";
import { loginBodySchema as loginBody, registerBodySchema as registerBody, type Role } from "@mini-payments/shared";
import { hashPassword, verifyAgainstDummy, verifyPassword } from "../auth/password.js";
import { badRequest } from "./common.js";

type UserRow = { id: string; email: string; name: string; password_hash: string };

function tooMany(reply: FastifyReply, retryAfterMs: number) {
  return reply
    .code(429)
    .header("retry-after", String(Math.ceil(retryAfterMs / 1000)))
    .send({ error: "too_many_attempts" });
}

export function authRoutes(app: FastifyInstance, auth: AuthContext) {
  const { db, sessions, limiters, clock } = auth;

  const insertUser = db.prepare(
    `INSERT INTO users (id, email, name, password_hash, created_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (email) DO NOTHING`,
  );
  const userByEmail = db.prepare<[string], UserRow>(
    "SELECT id, email, name, password_hash FROM users WHERE email = ?",
  );
  const userById = db.prepare<[string], { id: string; email: string; name: string }>(
    "SELECT id, email, name FROM users WHERE id = ?",
  );
  const membershipsOf = db.prepare<[string], { orgId: string; orgName: string; role: Role }>(
    `SELECT m.org_id AS orgId, o.name AS orgName, m.role
     FROM memberships m JOIN orgs o ON o.id = m.org_id
     WHERE m.user_id = ? ORDER BY m.org_id`,
  );

  // Same response whether or not the email was already registered.
  app.post("/auth/register", async (req, reply) => {
    const body = registerBody.safeParse(req.body);
    if (!body.success) return badRequest(reply, body.error);
    const { email, name, password } = body.data;

    const ipKey = `ip:${req.ip}`;
    const wait = Math.max(limiters.registerIp.retryAfterMs(ipKey), limiters.registerEmail.retryAfterMs(email));
    if (wait > 0) return tooMany(reply, wait);
    limiters.registerIp.hit(ipKey);
    limiters.registerEmail.hit(email);

    // Hash even if the email exists, so timing is the same either way.
    const hash = await hashPassword(password);
    insertUser.run(`usr_${randomUUID()}`, email, name, hash, new Date(clock()).toISOString());
    return reply.code(202).send({ status: "accepted" });
  });

  app.post("/auth/login", async (req, reply) => {
    const body = loginBody.safeParse(req.body);
    if (!body.success) return badRequest(reply, body.error);
    const { email, password } = body.data;

    const ipKey = `ip:${req.ip}`;
    // Checked before the password, so a locked account can't be used as a guessing oracle.
    const wait = Math.max(limiters.loginIp.retryAfterMs(ipKey), limiters.loginEmail.retryAfterMs(email));
    if (wait > 0) return tooMany(reply, wait);

    const user = userByEmail.get(email);
    const ok = user ? await verifyPassword(user.password_hash, password) : await verifyAgainstDummy(password);
    if (!user || !ok) {
      limiters.loginIp.hit(ipKey);
      limiters.loginEmail.hit(email);
      return reply.code(401).send({ error: "invalid_credentials" });
    }

    limiters.loginEmail.reset(email);
    const { token, expiresAt } = sessions.create(user.id, req.headers["user-agent"] ?? null, bearerToken(req));
    return { token, expiresAt, user: { id: user.id, email: user.email, name: user.name } };
  });

  app.post("/auth/logout", async (req, reply) => {
    sessions.destroy(bearerToken(req));
    return reply.code(204).send();
  });

  app.get("/me", async (req, reply) => {
    const session = sessions.validate(bearerToken(req));
    if (!session) return reply.code(401).send({ error: "unauthenticated" });
    const user = userById.get(session.userId);
    if (!user) return reply.code(401).send({ error: "unauthenticated" });
    return { user, memberships: membershipsOf.all(user.id), session: { expiresAt: session.expiresAt } };
  });
}
