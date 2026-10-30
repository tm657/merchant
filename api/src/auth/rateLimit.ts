import type { Clock } from "./sessions.js";

type Entry = { count: number; windowStart: number; lockedUntil: number };

/**
 * Counts attempts per key in a fixed window. Reaching `max` locks the key for `lockoutMs`.
 * In memory, so limits are per API process (fine for one instance; use Redis for several).
 */
export class AttemptLimiter {
  private readonly entries = new Map<string, Entry>();

  constructor(
    private readonly opts: { max: number; windowMs: number; lockoutMs: number },
    private readonly clock: Clock = Date.now,
  ) {}

  /** 0 if the key may proceed, otherwise milliseconds until it may. */
  retryAfterMs(key: string): number {
    const entry = this.entries.get(key);
    if (!entry) return 0;
    return Math.max(0, entry.lockedUntil - this.clock());
  }

  hit(key: string): void {
    const now = this.clock();
    this.prune(now);
    let entry = this.entries.get(key);
    if (!entry || now - entry.windowStart >= this.opts.windowMs) {
      entry = { count: 0, windowStart: now, lockedUntil: entry?.lockedUntil ?? 0 };
      this.entries.set(key, entry);
    }
    entry.count++;
    if (entry.count >= this.opts.max) {
      entry.lockedUntil = now + this.opts.lockoutMs;
      // A fresh window starts after the lockout.
      entry.count = 0;
      entry.windowStart = entry.lockedUntil;
    }
  }

  reset(key: string): void {
    this.entries.delete(key);
  }

  // Keeps memory bounded when many distinct keys show up.
  private prune(now: number): void {
    if (this.entries.size < 10_000) return;
    for (const [key, e] of this.entries) {
      if (e.lockedUntil <= now && now - e.windowStart >= this.opts.windowMs) this.entries.delete(key);
    }
  }
}

const MINUTE = 60_000;

export function createLimiters(clock: Clock = Date.now) {
  return {
    // Failed logins only. 5 wrong passwords for one email locks it for 5 minutes.
    loginEmail: new AttemptLimiter({ max: 5, windowMs: 15 * MINUTE, lockoutMs: 5 * MINUTE }, clock),
    loginIp: new AttemptLimiter({ max: 20, windowMs: 15 * MINUTE, lockoutMs: 5 * MINUTE }, clock),
    // Every registration attempt counts.
    registerEmail: new AttemptLimiter({ max: 3, windowMs: 15 * MINUTE, lockoutMs: 15 * MINUTE }, clock),
    registerIp: new AttemptLimiter({ max: 5, windowMs: 15 * MINUTE, lockoutMs: 15 * MINUTE }, clock),
  };
}

export type Limiters = ReturnType<typeof createLimiters>;
