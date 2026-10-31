import type { Currency, PayoutStatus } from "@mini-payments/shared";
import type { FastifyBaseLogger } from "fastify";
import type { Clock } from "../auth/sessions.js";
import { withTransaction, type Db } from "../db.js";
import { TransientProviderError, type PayoutProvider, type ProviderResult } from "./provider.js";
import { SYSTEM } from "../audit.js";
import { enqueueBalance, recordTransition } from "./service.js";

export type Claim = {
  id: string;
  orgId: string;
  amount: number;
  currency: Currency;
  accountNumber: string;
  /** Fencing token: completion only applies while the row still has this attempt number. */
  attempts: number;
  version: number;
};

type Options = {
  db: Db;
  provider: PayoutProvider;
  log: FastifyBaseLogger;
  clock?: Clock;
  /** How long a claim is ours. A crashed worker's rows are reclaimed after this. */
  leaseMs?: number;
  maxAttempts?: number;
  backoffBaseMs?: number;
  backoffMaxMs?: number;
  /** Provider calls longer than this count as a transient timeout. Keep it under leaseMs. */
  providerTimeoutMs?: number;
  random?: () => number;
};

type Outcome = { kind: "result"; result: ProviderResult } | { kind: "transient"; message: string };

export function createPayoutWorker({
  db,
  provider,
  log,
  clock = Date.now,
  leaseMs = 30_000,
  maxAttempts = 5,
  backoffBaseMs = 1000,
  backoffMaxMs = 60_000,
  providerTimeoutMs = 10_000,
  random = Math.random,
}: Options) {
  const iso = (ms = clock()) => new Date(ms).toISOString();

  /** Exponential backoff with ±20% jitter: about 1 s, 2 s, 4 s, ... capped. */
  const backoff = (attempt: number) =>
    Math.round(Math.min(backoffMaxMs, backoffBaseMs * 2 ** (attempt - 1)) * (0.8 + random() * 0.4));

  /**
   * Claims up to `limit` rows: approved ones, and processing ones whose lease ran out
   * (a crashed worker) or whose retry is due. SKIP LOCKED means two workers running this
   * at the same moment get disjoint rows.
   */
  async function claim(limit: number): Promise<Claim[]> {
    return withTransaction(db, async (tx) => {
      const now = iso();
      const { rows } = await tx.query<{
        id: string;
        org_id: string;
        status: PayoutStatus;
        version: number;
        amount: number;
        currency: Currency;
        account_number: string;
        attempts: number;
      }>(
        `SELECT id, org_id, status, version, amount, currency, account_number, attempts
         FROM payouts
         WHERE (status = 'approved' OR (status = 'processing' AND (lease_expires_at IS NULL OR lease_expires_at <= $1)))
           AND next_attempt_at <= $1
         ORDER BY next_attempt_at, id
         LIMIT $2
         FOR UPDATE SKIP LOCKED`,
        [now, limit],
      );

      const claims: Claim[] = [];
      for (const r of rows) {
        const attempts = r.attempts + 1;
        const version = r.status === "approved" ? r.version + 1 : r.version;
        await tx.query(
          `UPDATE payouts SET status = 'processing', attempts = $2, version = $3, lease_expires_at = $4, updated_at = $5
           WHERE id = $1`,
          [r.id, attempts, version, iso(clock() + leaseMs), now],
        );
        if (r.status === "approved") {
          await recordTransition(tx, { orgId: r.org_id, payoutId: r.id, from: "approved", to: "processing", version }, SYSTEM, null, now);
        }
        claims.push({
          id: r.id,
          orgId: r.org_id,
          amount: r.amount,
          currency: r.currency,
          accountNumber: r.account_number,
          attempts,
          version,
        });
      }
      return claims;
    });
  }

  async function callProvider(c: Claim): Promise<Outcome> {
    let timer: NodeJS.Timeout | undefined;
    try {
      const result = await Promise.race([
        provider.send({ payoutId: c.id, amount: c.amount, currency: c.currency, accountNumber: c.accountNumber }),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new TransientProviderError("timeout")), providerTimeoutMs);
        }),
      ]);
      return { kind: "result", result };
    } catch (err) {
      // Anything unexpected (e.g. the provider's own storage) is retried too.
      return { kind: "transient", message: err instanceof Error ? err.message : String(err) };
    } finally {
      clearTimeout(timer);
    }
  }

  /** Applies the outcome: state change, balance change and outbox rows commit together. */
  async function complete(c: Claim, outcome: Outcome): Promise<PayoutStatus | "retry" | "lost"> {
    return withTransaction(db, async (tx) => {
      const now = iso();
      const { rows } = await tx.query<{ version: number }>(
        "SELECT version FROM payouts WHERE id = $1 AND status = 'processing' AND attempts = $2 FOR UPDATE",
        [c.id, c.attempts],
      );
      if (!rows[0]) {
        // Our lease expired and another worker took over (or finished) this pay-out.
        log.warn({ payoutId: c.id, attempts: c.attempts }, "lost the claim on a pay-out, discarding result");
        return "lost";
      }
      const version = rows[0].version;
      const ref = { orgId: c.orgId, payoutId: c.id, from: "processing" as const };

      if (outcome.kind === "transient" && c.attempts < maxAttempts) {
        const delay = backoff(c.attempts);
        const retryAt = iso(clock() + delay);
        await tx.query("UPDATE payouts SET lease_expires_at = NULL, next_attempt_at = $2, updated_at = $3 WHERE id = $1", [
          c.id,
          retryAt,
          now,
        ]);
        await recordTransition(
          tx,
          { ...ref, to: "processing", version },
          SYSTEM,
          `Provider error (${outcome.message}), retry ${c.attempts + 1} of ${maxAttempts} at ${retryAt}`,
          now,
        );
        return "retry";
      }

      const paid = outcome.kind === "result" && outcome.result.outcome === "paid";
      const failureReason =
        outcome.kind === "transient"
          ? `provider_unavailable: ${outcome.message} after ${c.attempts} attempts`
          : outcome.result.outcome === "declined"
            ? `declined: ${outcome.result.reason}`
            : null;

      // Lock order: pay-out row (above), then balance row.
      // Paid: the reserved money has left. Failed: it goes back to available.
      const { rows: balance } = await tx.query<{ available: number; reserved: number }>(
        `UPDATE balances
         SET reserved = reserved - $3, available = available + $4, updated_at = $5
         WHERE org_id = $1 AND currency = $2
         RETURNING available, reserved`,
        [c.orgId, c.currency, c.amount, paid ? 0 : c.amount, now],
      );
      if (!balance[0]) throw new Error(`no ${c.currency} balance row for ${c.orgId}`);

      const to: PayoutStatus = paid ? "paid" : "failed";
      const next = version + 1;
      await tx.query(
        `UPDATE payouts SET status = $2, version = $3, provider_ref = $4, failure_reason = $5,
                            lease_expires_at = NULL, next_attempt_at = NULL, updated_at = $6
         WHERE id = $1`,
        [
          c.id,
          to,
          next,
          outcome.kind === "result" && outcome.result.outcome === "paid" ? outcome.result.reference : null,
          failureReason,
          now,
        ],
      );
      await recordTransition(tx, { ...ref, to, version: next }, SYSTEM, failureReason, now);
      await enqueueBalance(tx, c.orgId, { currency: c.currency, ...balance[0] }, now);
      return to;
    });
  }

  async function processClaim(c: Claim) {
    const outcome = await callProvider(c);
    const result = await complete(c, outcome);
    log.info({ payoutId: c.id, attempt: c.attempts, result }, "pay-out attempt finished");
    return result;
  }

  /** Claims one batch and processes it. Returns how many rows were claimed. */
  async function runOnce(batchSize: number): Promise<number> {
    const claims = await claim(batchSize);
    await Promise.all(
      claims.map((c) =>
        processClaim(c).catch((err: unknown) => {
          // The lease runs out and another attempt picks it up.
          log.error({ err, payoutId: c.id }, "pay-out attempt crashed");
        }),
      ),
    );
    return claims.length;
  }

  return { claim, complete, processClaim, runOnce };
}

export type PayoutWorker = ReturnType<typeof createPayoutWorker>;
