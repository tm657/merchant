import { Redis } from "ioredis";

/**
 * Command client (rate limits, publishing, /readyz). Commands fail at once while
 * disconnected instead of queueing, so callers can answer 503 right away.
 */
export function createRedis(url: string): Redis {
  return new Redis(url, {
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
    connectTimeout: 2000,
    // Keep retrying in the background, backing off to 5 s.
    retryStrategy: (times) => Math.min(times * 200, 5000),
  });
}

/**
 * Pub/sub client. A subscribed connection can't run other commands, so it is separate.
 * Its offline queue stays on so SUBSCRIBE issued while connecting isn't lost, and
 * ioredis re-subscribes every channel after a reconnect.
 */
export function createSubscriber(url: string): Redis {
  return new Redis(url, {
    connectTimeout: 2000,
    maxRetriesPerRequest: 1,
    autoResubscribe: true,
    retryStrategy: (times) => Math.min(times * 200, 5000),
  });
}
