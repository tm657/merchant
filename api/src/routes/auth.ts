import { loginBodySchema as loginBody, registerBodySchema as registerBody, type Role } from "@mini-payments/shared";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { randomUUID } from "node:crypto";
import { bearerToken, type AuthContext } from "../auth/context.js";
import { hashPassword, verifyAgainstDummy, verifyPassword } from "../auth/password.js";
import { RateLimiterUnavailableError } from "../auth/rateLimit.js";
import { badRequest, unavailable } from "./common.js";

type UserRow = { id: string; email: string; name: string; password_hash: string };

function tooMany(reply: FastifyReply, retryAfterMs: number) {
  return reply
    .code(429)
    .header("retry-after", String(Math.ceil(retryAfterMs / 1000)))
    .send({ error: "too_many_attempts" });
}

/** Login and register can't run without their rate limits: fail closed with a 503. */
function rateLimited<R>(handler: (req: FastifyRequest, reply: FastifyReply) => Promise<R>) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    try {
      return await handler(req, reply);
    } catch (err) {
      if (!(err instanceof RateLimiterUnavailableError)) throw err;
      req.log.error({ err: err.cause }, "rate limiter unavailable, refusing request");
      return unavailable(reply);
    }
  };
}

export function authRoutes(app: FastifyInstance, auth: AuthContext) {
  const { db, sessions, limiters, clock } = auth;

  // Same response whether or not the email was already registered.
  app.post(
    "/auth/register",
    rateLimited(async (req, reply) => {
      const body = registerBody.safeParse(req.body);
      if (!body.success) return badRequest(reply, body.error);
      const { email, name, password } = body.data;

      const ipKey = `ip:${req.ip}`;
      const wait = Math.max(
        await limiters.registerIp.retryAfterMs(ipKey),
        await limiters.registerEmail.retryAfterMs(email),
      );
      if (wait > 0) return tooMany(reply, wait);
      await limiters.registerIp.hit(ipKey);
      await limiters.registerEmail.hit(email);

      // Hash even if the email exists, so timing is the same either way.
      const hash = await hashPassword(password);
      await db.query(
        `INSERT INTO users (id, email, name, password_hash, created_at) VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (email) DO NOTHING`,
        [`usr_${randomUUID()}`, email, name, hash, new Date(clock()).toISOString()],
      );
      return reply.code(202).send({ status: "accepted" });
    }),
  );

  app.post(
    "/auth/login",
    rateLimited(async (req, reply) => {
      const body = loginBody.safeParse(req.body);
      if (!body.success) return badRequest(reply, body.error);
      const { email, password } = body.data;

      const ipKey = `ip:${req.ip}`;
      // Checked before the password, so a locked account can't be used as a guessing oracle.
      const wait = Math.max(await limiters.loginIp.retryAfterMs(ipKey), await limiters.loginEmail.retryAfterMs(email));
      if (wait > 0) return tooMany(reply, wait);

      const { rows } = await db.query<UserRow>("SELECT id, email, name, password_hash FROM users WHERE email = $1", [
        email,
      ]);
      const user = rows[0];
      const ok = user ? await verifyPassword(user.password_hash, password) : await verifyAgainstDummy(password);
      if (!user || !ok) {
        await limiters.loginIp.hit(ipKey);
        await limiters.loginEmail.hit(email);
        return reply.code(401).send({ error: "invalid_credentials" });
      }

      await limiters.loginEmail.reset(email);
      const { token, expiresAt } = await sessions.create(user.id, req.headers["user-agent"] ?? null, bearerToken(req));
      return { token, expiresAt, user: { id: user.id, email: user.email, name: user.name } };
    }),
  );

  app.post("/auth/logout", async (req, reply) => {
    await sessions.destroy(bearerToken(req));
    return reply.code(204).send();
  });

  app.get("/me", async (req, reply) => {
    const session = await sessions.validate(bearerToken(req));
    if (!session) return reply.code(401).send({ error: "unauthenticated" });
    const { rows: users } = await db.query<{ id: string; email: string; name: string }>(
      "SELECT id, email, name FROM users WHERE id = $1",
      [session.userId],
    );
    const user = users[0];
    if (!user) return reply.code(401).send({ error: "unauthenticated" });
    const { rows: memberships } = await db.query<{ orgId: string; orgName: string; role: Role }>(
      `SELECT m.org_id AS "orgId", o.name AS "orgName", m.role
       FROM memberships m JOIN orgs o ON o.id = m.org_id
       WHERE m.user_id = $1 ORDER BY m.org_id`,
      [user.id],
    );
    return { user, memberships, session: { expiresAt: session.expiresAt } };
  });
}
