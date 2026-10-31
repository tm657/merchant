import type { Currency } from "@mini-payments/shared";
import type { Redis } from "ioredis";
import { randomUUID } from "node:crypto";

export type ProviderRequest = { payoutId: string; amount: number; currency: Currency; accountNumber: string };
export type ProviderResult = { outcome: "paid"; reference: string } | { outcome: "declined"; reason: string };

/** A failure worth retrying (timeout, 5xx). Anything the provider decided is a ProviderResult. */
export class TransientProviderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TransientProviderError";
  }
}

export interface PayoutProvider {
  /** Idempotent per payoutId: asking again returns the same final result. */
  send(req: ProviderRequest): Promise<ProviderResult>;
}

const DECLINE_REASONS = ["account_closed", "invalid_account", "beneficiary_bank_rejected"];
const TRANSIENT_ERRORS = ["timeout", "503 service unavailable", "connection reset"];
const RESULT_TTL_SECONDS = 7 * 24 * 60 * 60;

type SimulatedOptions = {
  redis: Redis;
  prefix?: string;
  minLatencyMs: number;
  maxLatencyMs: number;
  /** Chance per attempt of a final decline. */
  declineRate: number;
  /** Chance per attempt of a retryable error. */
  transientRate: number;
  random?: () => number;
};

/**
 * Stands in for a real payment provider: random latency, some declines, some transient
 * errors. Like a real provider it is idempotent per pay-out: its final answer is kept in
 * Redis, so a retry after a crash can't pay twice.
 */
export function createSimulatedProvider(o: SimulatedOptions): PayoutProvider {
  const random = o.random ?? Math.random;
  const key = (payoutId: string) => `${o.prefix ?? ""}provider:payout:${payoutId}`;
  const pick = <T>(xs: readonly T[]) => xs[Math.floor(random() * xs.length)] as T;

  return {
    async send(req) {
      const stored = await o.redis.get(key(req.payoutId));
      if (stored) return JSON.parse(stored) as ProviderResult;

      await new Promise((r) => setTimeout(r, o.minLatencyMs + random() * (o.maxLatencyMs - o.minLatencyMs)));
      const roll = random();
      if (roll < o.transientRate) throw new TransientProviderError(pick(TRANSIENT_ERRORS));
      const result: ProviderResult =
        roll < o.transientRate + o.declineRate
          ? { outcome: "declined", reason: pick(DECLINE_REASONS) }
          : { outcome: "paid", reference: `prv_${randomUUID()}` };

      // First answer wins, even if two attempts raced.
      await o.redis.set(key(req.payoutId), JSON.stringify(result), "EX", RESULT_TTL_SECONDS, "NX");
      return JSON.parse((await o.redis.get(key(req.payoutId))) ?? JSON.stringify(result)) as ProviderResult;
    },
  };
}
