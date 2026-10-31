import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { withTransaction, type Db, type Queryable } from "../db.js";

export const IDLE_TIMEOUT_MS = 30 * 60_000;
export const ABSOLUTE_LIFETIME_MS = 8 * 60 * 60_000;

export type Clock = () => number;

// 32 random bytes, base64url encoded.
const TOKEN_FORMAT = /^[A-Za-z0-9_-]{43}$/;

export function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export type Session = { id: string; userId: string; expiresAt: string };

type Row = {
  id: string;
  user_id: string;
  token_hash: string;
  last_seen_at: string;
  expires_at: string;
};

export function createSessionStore(db: Db, clock: Clock = Date.now) {
  const iso = (ms: number) => new Date(ms).toISOString();

  return {
    /**
     * Returns the raw token. It is never stored, so this is the only time it exists.
     * `inTransaction` runs in the same transaction (e.g. to write the audit entry).
     */
    create(
      userId: string,
      userAgent: string | null,
      replaceToken: string | null = null,
      inTransaction?: (tx: Queryable, now: string) => Promise<void>,
    ) {
      return withTransaction(db, async (tx) => {
        const now = clock();
        // Rotation: the browser's previous session (if any) ends when it logs in again.
        if (replaceToken && TOKEN_FORMAT.test(replaceToken)) {
          await tx.query("DELETE FROM sessions WHERE token_hash = $1", [hashToken(replaceToken)]);
        }
        await tx.query("DELETE FROM sessions WHERE user_id = $1 AND (expires_at <= $2 OR last_seen_at <= $3)", [
          userId,
          iso(now),
          iso(now - IDLE_TIMEOUT_MS),
        ]);

        const token = randomBytes(32).toString("base64url");
        const expiresAt = iso(now + ABSOLUTE_LIFETIME_MS);
        await tx.query(
          `INSERT INTO sessions (id, user_id, token_hash, created_at, last_seen_at, expires_at, user_agent)
           VALUES ($1, $2, $3, $4, $4, $5, $6)`,
          [randomUUID(), userId, hashToken(token), iso(now), expiresAt, userAgent?.slice(0, 512) ?? null],
        );
        await inTransaction?.(tx, iso(now));
        return { token, expiresAt };
      });
    },

    /**
     * Returns the session if the token is valid and not expired.
     * `touch: false` checks without counting as activity (used by stream heartbeats).
     */
    async validate(token: string | null | undefined, opts: { touch?: boolean } = {}): Promise<Session | null> {
      if (!token || !TOKEN_FORMAT.test(token)) return null;
      const hash = hashToken(token);
      const { rows } = await db.query<Row>(
        "SELECT id, user_id, token_hash, last_seen_at, expires_at FROM sessions WHERE token_hash = $1",
        [hash],
      );
      const row = rows[0];
      if (!row) return null;
      // The lookup already matched; compare again in constant time as a safeguard.
      if (!timingSafeEqual(Buffer.from(row.token_hash, "hex"), Buffer.from(hash, "hex"))) return null;

      const now = clock();
      const idleFor = now - Date.parse(row.last_seen_at);
      if (now >= Date.parse(row.expires_at) || idleFor >= IDLE_TIMEOUT_MS) {
        await db.query("DELETE FROM sessions WHERE id = $1", [row.id]);
        return null;
      }
      if (opts.touch !== false) await db.query("UPDATE sessions SET last_seen_at = $1 WHERE id = $2", [iso(now), row.id]);
      return { id: row.id, userId: row.user_id, expiresAt: row.expires_at };
    },

    /**
     * Ends the session. `inTransaction` runs in the same transaction, only if a session
     * was actually deleted, with the user it belonged to.
     */
    async destroy(
      token: string | null | undefined,
      inTransaction?: (tx: Queryable, userId: string, now: string) => Promise<void>,
    ): Promise<void> {
      if (!token || !TOKEN_FORMAT.test(token)) return;
      await withTransaction(db, async (tx) => {
        const { rows } = await tx.query<{ user_id: string }>("DELETE FROM sessions WHERE token_hash = $1 RETURNING user_id", [
          hashToken(token),
        ]);
        if (rows[0]) await inTransaction?.(tx, rows[0].user_id, iso(clock()));
      });
    },
  };
}

export type SessionStore = ReturnType<typeof createSessionStore>;
