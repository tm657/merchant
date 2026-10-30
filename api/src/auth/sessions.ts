import type Database from "better-sqlite3";
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";

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

export function createSessionStore(db: Database.Database, clock: Clock = Date.now) {
  const insert = db.prepare(
    `INSERT INTO sessions (id, user_id, token_hash, created_at, last_seen_at, expires_at, user_agent)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  const byHash = db.prepare<[string], Row>(
    "SELECT id, user_id, token_hash, last_seen_at, expires_at FROM sessions WHERE token_hash = ?",
  );
  const touch = db.prepare("UPDATE sessions SET last_seen_at = ? WHERE id = ?");
  const deleteById = db.prepare("DELETE FROM sessions WHERE id = ?");
  const deleteByHash = db.prepare("DELETE FROM sessions WHERE token_hash = ?");
  const deleteExpiredForUser = db.prepare(
    "DELETE FROM sessions WHERE user_id = ? AND (expires_at <= ? OR last_seen_at <= ?)",
  );

  const iso = (ms: number) => new Date(ms).toISOString();

  const create = db.transaction(
    (userId: string, userAgent: string | null, replaceToken: string | null) => {
      const now = clock();
      // Rotation: the browser's previous session (if any) ends when it logs in again.
      if (replaceToken && TOKEN_FORMAT.test(replaceToken)) deleteByHash.run(hashToken(replaceToken));
      deleteExpiredForUser.run(userId, iso(now), iso(now - IDLE_TIMEOUT_MS));

      const token = randomBytes(32).toString("base64url");
      const expiresAt = iso(now + ABSOLUTE_LIFETIME_MS);
      insert.run(randomUUID(), userId, hashToken(token), iso(now), iso(now), expiresAt, userAgent?.slice(0, 512) ?? null);
      return { token, expiresAt };
    },
  );

  return {
    /** Returns the raw token. It is never stored, so this is the only time it exists. */
    create(userId: string, userAgent: string | null, replaceToken: string | null = null) {
      return create(userId, userAgent, replaceToken);
    },

    /**
     * Returns the session if the token is valid and not expired.
     * `touch: false` checks without counting as activity (used by stream heartbeats).
     */
    validate(token: string | null | undefined, opts: { touch?: boolean } = {}): Session | null {
      if (!token || !TOKEN_FORMAT.test(token)) return null;
      const hash = hashToken(token);
      const row = byHash.get(hash);
      if (!row) return null;
      // The lookup already matched; compare again in constant time as a safeguard.
      if (!timingSafeEqual(Buffer.from(row.token_hash, "hex"), Buffer.from(hash, "hex"))) return null;

      const now = clock();
      const idleFor = now - Date.parse(row.last_seen_at);
      if (now >= Date.parse(row.expires_at) || idleFor >= IDLE_TIMEOUT_MS) {
        deleteById.run(row.id);
        return null;
      }
      if (opts.touch !== false) touch.run(iso(now), row.id);
      return { id: row.id, userId: row.user_id, expiresAt: row.expires_at };
    },

    destroy(token: string | null | undefined): void {
      if (token && TOKEN_FORMAT.test(token)) deleteByHash.run(hashToken(token));
    },
  };
}

export type SessionStore = ReturnType<typeof createSessionStore>;
