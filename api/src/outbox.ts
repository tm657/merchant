import type { FastifyBaseLogger } from "fastify";
import type { WebhookEventType } from "@mini-payments/shared";
import type { Redis } from "ioredis";
import { randomUUID } from "node:crypto";
import { withTransaction, type Db, type Queryable } from "./db.js";
import { orgEventSchema, publishOrgEvent, type OrgEvent } from "./events.js";

/**
 * Records an event in the same transaction as the change that caused it, so the event
 * exists if and only if the change committed. Never publish to Redis from inside a
 * transaction: the publisher does that after commit.
 */
export async function enqueueEvent(tx: Queryable, orgId: string, event: OrgEvent, now: string): Promise<void> {
  const { type, ...payload } = orgEventSchema.parse(event);
  await tx.query("INSERT INTO outbox (org_id, type, payload, created_at) VALUES ($1, $2, $3, $4)", [
    orgId,
    type,
    JSON.stringify(payload),
    now,
  ]);
}

/**
 * Records a webhook event for fan-out. The payload is a snapshot taken now, inside the
 * transaction, so endpoints see the object as it was when the event happened.
 */
export async function enqueueWebhookEvent(
  tx: Queryable,
  orgId: string,
  type: WebhookEventType,
  data: Record<string, unknown>,
  now: string,
): Promise<void> {
  const event = { id: `evt_${randomUUID()}`, type, createdAt: now, orgId, data };
  await tx.query("INSERT INTO outbox (org_id, type, payload, created_at) VALUES ($1, 'webhook', $2, $3)", [
    orgId,
    JSON.stringify(event),
    now,
  ]);
}

/**
 * Creates one pending delivery per enabled endpoint subscribed to this event. Idempotent:
 * if the outbox row is processed twice, the unique (endpoint, event) index skips repeats.
 */
async function fanOutWebhook(tx: Queryable, orgId: string, payload: Record<string, unknown>, now: string): Promise<void> {
  const body = JSON.stringify(payload);
  await tx.query(
    `INSERT INTO webhook_deliveries (id, org_id, endpoint_id, event_id, event_type, body, status, attempts, next_attempt_at, created_at)
     SELECT 'whd_' || gen_random_uuid(), e.org_id, e.id, $2, $3, $4, 'pending', 0, $5, $5
     FROM webhook_endpoints e
     WHERE e.org_id = $1 AND e.enabled AND $3 = ANY (e.events)
     ON CONFLICT (endpoint_id, event_id) WHERE redelivery_of IS NULL DO NOTHING`,
    [orgId, payload.id, payload.type, body, now],
  );
}

type OutboxRow = { id: number; org_id: string; type: string; payload: Record<string, unknown> };

/**
 * Publishes one batch of unpublished events in id order and marks them published:
 * SSE events go to Redis, webhook events fan out to webhook_deliveries (same transaction).
 * SKIP LOCKED lets several publishers run without sending the same row twice at once.
 * Delivery is at-least-once: if Redis fails mid-batch, the whole batch rolls back and is
 * sent again later, so consumers must tolerate duplicates (events carry a version).
 * Returns how many events were published.
 */
export async function publishOutboxBatch(
  db: Db,
  redis: Redis,
  { prefix = "", batchSize = 100, now = () => new Date().toISOString(), log }: {
    prefix?: string;
    batchSize?: number;
    now?: () => string;
    log?: FastifyBaseLogger;
  } = {},
): Promise<number> {
  return withTransaction(db, async (tx) => {
    const { rows } = await tx.query<OutboxRow>(
      `SELECT id, org_id, type, payload FROM outbox
       WHERE published_at IS NULL
       ORDER BY id
       LIMIT $1
       FOR UPDATE SKIP LOCKED`,
      [batchSize],
    );
    const published: number[] = [];
    for (const row of rows) {
      if (row.type === "webhook") {
        await fanOutWebhook(tx, row.org_id, row.payload, now());
        published.push(row.id);
        continue;
      }
      const event = orgEventSchema.safeParse({ ...row.payload, type: row.type });
      // A row that can never be valid is marked published so it doesn't block the queue.
      if (!event.success) log?.error({ outboxId: row.id }, "dropping malformed outbox event");
      else await publishOrgEvent(redis, prefix, row.org_id, event.data);
      published.push(row.id);
    }
    if (published.length > 0) {
      await tx.query("UPDATE outbox SET published_at = $1 WHERE id = ANY($2::bigint[])", [now(), published]);
    }
    return published.length;
  });
}

/** Deletes published events older than `olderThan`. */
export async function purgePublishedOutbox(db: Queryable, olderThan: string): Promise<number> {
  const { rowCount } = await db.query("DELETE FROM outbox WHERE published_at IS NOT NULL AND published_at < $1", [olderThan]);
  return rowCount ?? 0;
}
