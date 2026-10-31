import { Redis } from "ioredis";

/** Redis client. Not used by features yet; /readyz pings it. */
export function createRedis(url: string): Redis {
  return new Redis(url, {
    // Fail commands at once while disconnected instead of queueing them,
    // so /readyz reports an outage instead of hanging.
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
    connectTimeout: 2000,
    // Keep retrying in the background, backing off to 5 s.
    retryStrategy: (times) => Math.min(times * 200, 5000),
  });
}
