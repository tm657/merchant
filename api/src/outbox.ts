import type { FastifyBaseLogger } from "fastify";
import type { Redis } from "ioredis";
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

type OutboxRow = { id: number; org_id: string; type: string; payload: Record<string, unknown> };

/**
 * Publishes one batch of unpublished events in id order and marks them published.
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
