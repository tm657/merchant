import { MAX_RUNNING_EXPORTS_PER_ORG } from "@mini-payments/shared";
import type { Redis } from "ioredis";
import type { Clock } from "../auth/sessions.js";

/**
 * Take a slot if the org has fewer than ARGV[3] live ones. A sorted set per org: member =
 * job id, score = when its lease ends. Expired members are dropped first, so a crashed
 * worker's slot frees itself, unlike a plain INCR/DECR counter. Atomic, so two workers
 * can't both take the last slot. Time comes from the app clock (ARGV[1]).
 */
const ACQUIRE = `
local now, leaseEnd, max = tonumber(ARGV[1]), tonumber(ARGV[2]), tonumber(ARGV[3])
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now)
if redis.call('ZSCORE', KEYS[1], ARGV[4]) or redis.call('ZCARD', KEYS[1]) < max then
  redis.call('ZADD', KEYS[1], leaseEnd, ARGV[4])
  redis.call('PEXPIRE', KEYS[1], math.max(1, leaseEnd - now))
  return 1
end
return 0
`;

export function createExportSlots(redis: Redis, { prefix = "", clock = Date.now as Clock, max = MAX_RUNNING_EXPORTS_PER_ORG } = {}) {
  const key = (orgId: string) => `${prefix}exports:running:${orgId}`;
  return {
    /** True if this job may run now (or already holds a slot). */
    async acquire(orgId: string, jobId: string, leaseMs: number): Promise<boolean> {
      const now = clock();
      return (await redis.eval(ACQUIRE, 1, key(orgId), now, now + leaseMs, max, jobId)) === 1;
    },
    /** Extends a held slot's lease (heartbeat while the export runs). */
    async renew(orgId: string, jobId: string, leaseMs: number): Promise<void> {
      await redis.zadd(key(orgId), "XX", clock() + leaseMs, jobId);
      await redis.pexpire(key(orgId), leaseMs);
    },
    async release(orgId: string, jobId: string): Promise<void> {
      await redis.zrem(key(orgId), jobId);
    },
    /** Live slots for an org (for tests and diagnostics). */
    async running(orgId: string): Promise<number> {
      return redis.zcount(key(orgId), clock(), "+inf");
    },
  };
}

export type ExportSlots = ReturnType<typeof createExportSlots>;
