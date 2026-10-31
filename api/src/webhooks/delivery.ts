import {
  WEBHOOK_EVENT_HEADER,
  WEBHOOK_ID_HEADER,
  WEBHOOK_MAX_ATTEMPTS,
  WEBHOOK_SIGNATURE_HEADER,
} from "@mini-payments/shared";
import type { FastifyBaseLogger } from "fastify";
import type { Clock } from "../auth/sessions.js";
import { withTransaction, type Db } from "../db.js";
import { decryptSecret, signatureHeader } from "./crypto.js";
import { sendWebhook, type SendResult, type WebhookSender } from "./http.js";
import type { TargetPolicy } from "./ssrf.js";

export type DeliveryClaim = {
  id: string;
  endpointId: string;
  eventId: string;
  eventType: string;
  body: string;
  /** Fencing token: completion only applies while the row still has this attempt number. */
  attempts: number;
  url: string;
  enabled: boolean;
  secretEnc: string;
  previousSecretEnc: string | null;
  previousSecretExpiresAt: string | null;
};

type Options = {
  db: Db;
  key: Buffer;
  policy: TargetPolicy;
  log: FastifyBaseLogger;
  clock?: Clock;
  send?: WebhookSender;
  maxAttempts?: number;
  leaseMs?: number;
  backoffBaseMs?: number;
  backoffMaxMs?: number;
  timeoutMs?: number;
  maxResponseBytes?: number;
  random?: () => number;
};

export function createDeliveryWorker({
  db,
  key,
  policy,
  log,
  clock = Date.now,
  send = sendWebhook,
  maxAttempts = WEBHOOK_MAX_ATTEMPTS,
  leaseMs = 30_000,
  backoffBaseMs = 5000,
  backoffMaxMs = 60 * 60 * 1000,
  timeoutMs = 5000,
  maxResponseBytes = 64 * 1024,
  random = Math.random,
}: Options) {
  const iso = (ms = clock()) => new Date(ms).toISOString();

  /** About 5 s, 10 s, 20 s, ... with ±20% jitter, capped. */
  const backoff = (attempt: number) =>
    Math.round(Math.min(backoffMaxMs, backoffBaseMs * 2 ** (attempt - 1)) * (0.8 + random() * 0.4));

  /**
   * Claims due deliveries: pending ones, and delivering ones whose lease ran out (a
   * crashed worker). SKIP LOCKED: concurrent workers get disjoint rows.
   */
  async function claim(limit: number): Promise<DeliveryClaim[]> {
    return withTransaction(db, async (tx) => {
      const now = iso();
      const { rows } = await tx.query<{ id: string; attempts: number }>(
        `SELECT id, attempts FROM webhook_deliveries
         WHERE (status = 'pending' OR (status = 'delivering' AND lease_expires_at <= $1))
           AND next_attempt_at <= $1
         ORDER BY next_attempt_at, id
         LIMIT $2
         FOR UPDATE SKIP LOCKED`,
        [now, limit],
      );
      if (rows.length === 0) return [];
      const { rows: claimed } = await tx.query<{
        id: string;
        endpoint_id: string;
        event_id: string;
        event_type: string;
        body: string;
        attempts: number;
        url: string;
        enabled: boolean;
        secret_enc: string;
        previous_secret_enc: string | null;
        previous_secret_expires_at: string | null;
      }>(
        `UPDATE webhook_deliveries d
         SET status = 'delivering', attempts = d.attempts + 1, lease_expires_at = $2, last_attempt_at = $3
         FROM webhook_endpoints e
         WHERE d.id = ANY($1::text[]) AND e.id = d.endpoint_id
         RETURNING d.id, d.endpoint_id, d.event_id, d.event_type, d.body, d.attempts,
                   e.url, e.enabled, e.secret_enc, e.previous_secret_enc, e.previous_secret_expires_at`,
        [rows.map((r) => r.id), iso(clock() + leaseMs), now],
      );
      return claimed.map((r) => ({
        id: r.id,
        endpointId: r.endpoint_id,
        eventId: r.event_id,
        eventType: r.event_type,
        body: r.body,
        attempts: r.attempts,
        url: r.url,
        enabled: r.enabled,
        secretEnc: r.secret_enc,
        previousSecretEnc: r.previous_secret_enc,
        previousSecretExpiresAt: r.previous_secret_expires_at,
      }));
    });
  }

  /** Signs with the current secret, and with the previous one while its grace period lasts. */
  function secretsFor(c: DeliveryClaim): string[] {
    const secrets = [decryptSecret(key, c.secretEnc, c.endpointId)];
    if (c.previousSecretEnc && c.previousSecretExpiresAt && Date.parse(c.previousSecretExpiresAt) > clock()) {
      // Only the current secret is required: an unreadable old one (e.g. after a key
      // change) just stops co-signing.
      try {
        secrets.push(decryptSecret(key, c.previousSecretEnc, c.endpointId));
      } catch {
        log.warn({ endpointId: c.endpointId }, "previous webhook secret unreadable, signing with the current one only");
      }
    }
    return secrets;
  }

  async function attempt(c: DeliveryClaim): Promise<SendResult> {
    if (!c.enabled) return { ok: false, status: null, error: "endpoint is disabled" };
    let secrets: string[];
    try {
      secrets = secretsFor(c);
    } catch {
      // Wrong WEBHOOK_SECRET_KEY or a tampered row: never send unsigned.
      return { ok: false, status: null, error: "could not decrypt the endpoint secret" };
    }
    return send({
      url: c.url,
      body: c.body,
      policy,
      timeoutMs,
      maxResponseBytes,
      headers: {
        "content-type": "application/json",
        "user-agent": "mini-payments-webhooks/1.0",
        [WEBHOOK_ID_HEADER]: c.eventId,
        [WEBHOOK_EVENT_HEADER]: c.eventType,
        [WEBHOOK_SIGNATURE_HEADER]: signatureHeader(secrets, c.body, Math.floor(clock() / 1000)),
      },
    });
  }

  /** Records the result: succeeded, retry later, or dead after the last attempt. */
  async function complete(c: DeliveryClaim, result: SendResult): Promise<"succeeded" | "retry" | "dead" | "lost"> {
    return withTransaction(db, async (tx) => {
      const now = iso();
      const { rowCount } = await tx.query(
        "SELECT 1 FROM webhook_deliveries WHERE id = $1 AND status = 'delivering' AND attempts = $2 FOR UPDATE",
        [c.id, c.attempts],
      );
      if (!rowCount) {
        log.warn({ deliveryId: c.id, attempts: c.attempts }, "lost the claim on a webhook delivery, discarding result");
        return "lost";
      }
      const error = result.error?.slice(0, 500) ?? null;
      if (result.ok) {
        await tx.query(
          `UPDATE webhook_deliveries SET status = 'succeeded', delivered_at = $2, last_response_code = $3, last_error = NULL,
                                         lease_expires_at = NULL, next_attempt_at = NULL
           WHERE id = $1`,
          [c.id, now, result.status],
        );
        return "succeeded";
      }
      const dead = c.attempts >= maxAttempts || !c.enabled;
      await tx.query(
        `UPDATE webhook_deliveries SET status = $2, last_response_code = $3, last_error = $4,
                                       lease_expires_at = NULL, next_attempt_at = $5
         WHERE id = $1`,
        [c.id, dead ? "dead" : "pending", result.status, error, dead ? null : iso(clock() + backoff(c.attempts))],
      );
      return dead ? "dead" : "retry";
    });
  }

  async function runOnce(batchSize: number): Promise<number> {
    const claims = await claim(batchSize);
    await Promise.all(
      claims.map(async (c) => {
        try {
          const result = await attempt(c);
          const outcome = await complete(c, result);
          log.info(
            { deliveryId: c.id, eventType: c.eventType, attempt: c.attempts, status: result.status, outcome },
            "webhook attempt finished",
          );
        } catch (err) {
          // The lease runs out and another attempt picks it up.
          log.error({ err, deliveryId: c.id }, "webhook attempt crashed");
        }
      }),
    );
    return claims.length;
  }

  return { claim, attempt, complete, runOnce };
}
