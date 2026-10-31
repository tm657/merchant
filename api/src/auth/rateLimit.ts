import type { Redis } from "ioredis";
import { createHash } from "node:crypto";
import type { Clock } from "./sessions.js";

type Options = { max: number; windowMs: number; lockoutMs: number };

/**
 * One hit, atomically. Same rules as before the move to Redis:
 * count attempts in a fixed window; reaching `max` locks the key for `lockoutMs`,
 * and a fresh window starts when the lockout ends.
 * Time comes from the app clock (ARGV[1]), not Redis, so tests can control it.
 * The hash expires once both its window and any lockout are over.
 */
const HIT_SCRIPT = `
local now, max, windowMs, lockoutMs = tonumber(ARGV[1]), tonumber(ARGV[2]), tonumber(ARGV[3]), tonumber(ARGV[4])
local e = redis.call('HMGET', KEYS[1], 'count', 'windowStart', 'lockedUntil')
local count, windowStart, lockedUntil = tonumber(e[1]), tonumber(e[2]), tonumber(e[3]) or 0
if count == nil or now - windowStart >= windowMs then
  count = 0
  windowStart = now
end
count = count + 1
if count >= max then
  lockedUntil = now + lockoutMs
  count = 0
  windowStart = lockedUntil
end
redis.call('HSET', KEYS[1], 'count', count, 'windowStart', windowStart, 'lockedUntil', lockedUntil)
redis.call('PEXPIRE', KEYS[1], math.max(1, math.max(windowStart + windowMs, lockedUntil) - now))
return count
`;

/** Redis couldn't be reached. Routes turn this into a 503 rather than skipping the limit. */
export class RateLimiterUnavailableError extends Error {
  constructor(cause: unknown) {
    super("rate limiter unavailable", { cause });
    this.name = "RateLimiterUnavailableError";
  }
}

async function orUnavailable<T>(op: Promise<T>): Promise<T> {
  try {
    return await op;
  } catch (err) {
    throw new RateLimiterUnavailableError(err);
  }
}

/**
 * Counts attempts per key in Redis, so limits hold across every API instance.
 * Every method rejects with RateLimiterUnavailableError if Redis is down; callers fail closed (503).
 */
export class AttemptLimiter {
  constructor(
    private readonly redis: Redis,
    private readonly name: string,
    private readonly opts: Options,
    private readonly clock: Clock = Date.now,
    private readonly prefix = "",
  ) {}

  // Keys can be emails, so only their hash is stored in Redis.
  private key(key: string): string {
    return `${this.prefix}rl:${this.name}:${createHash("sha256").update(key, "utf8").digest("hex")}`;
  }

  /** 0 if the key may proceed, otherwise milliseconds until it may. */
  async retryAfterMs(key: string): Promise<number> {
    const lockedUntil = Number((await orUnavailable(this.redis.hget(this.key(key), "lockedUntil"))) ?? 0);
    return Math.max(0, lockedUntil - this.clock());
  }

  async hit(key: string): Promise<void> {
    const { max, windowMs, lockoutMs } = this.opts;
    await orUnavailable(this.redis.eval(HIT_SCRIPT, 1, this.key(key), this.clock(), max, windowMs, lockoutMs));
  }

  async reset(key: string): Promise<void> {
    await orUnavailable(this.redis.del(this.key(key)));
  }
}

const MINUTE = 60_000;

export function createLimiters(redis: Redis, clock: Clock = Date.now, prefix = "") {
  const limiter = (name: string, opts: Options) => new AttemptLimiter(redis, name, opts, clock, prefix);
  return {
    // Failed logins only. 5 wrong passwords for one email locks it for 5 minutes.
    loginEmail: limiter("login-email", { max: 5, windowMs: 15 * MINUTE, lockoutMs: 5 * MINUTE }),
    loginIp: limiter("login-ip", { max: 20, windowMs: 15 * MINUTE, lockoutMs: 5 * MINUTE }),
    // Every registration attempt counts.
    registerEmail: limiter("register-email", { max: 3, windowMs: 15 * MINUTE, lockoutMs: 15 * MINUTE }),
    registerIp: limiter("register-ip", { max: 5, windowMs: 15 * MINUTE, lockoutMs: 15 * MINUTE }),
  };
}

export type Limiters = ReturnType<typeof createLimiters>;
