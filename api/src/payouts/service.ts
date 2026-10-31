import {
  canTransition,
  type CreatePayoutBody,
  type Currency,
  type Payout,
  type PayoutDetail,
  type PayoutStatus,
  type PayoutTimelineEntry,
} from "@mini-payments/shared";
import type pg from "pg";
import { createHash, randomUUID } from "node:crypto";
import type { Clock } from "../auth/sessions.js";
import { decodePayoutCursor, encodePayoutCursor } from "../cursor.js";
import { withTransaction, type Db, type Queryable } from "../db.js";
import { enqueueEvent } from "../outbox.js";

/** A refusal with the HTTP status and error code the route should send. */
export class PayoutError extends Error {
  constructor(
    readonly status: 400 | 403 | 404 | 409 | 422,
    readonly code: string,
  ) {
    super(code);
    this.name = "PayoutError";
  }
}

type PayoutRow = {
  id: string;
  org_id: string;
  amount: number;
  currency: Currency;
  status: PayoutStatus;
  version: number;
  beneficiary_name: string;
  account_number: string;
  reference: string;
  created_by: string;
  created_by_name: string;
  decided_by: string | null;
  decided_by_name: string | null;
  reject_reason: string | null;
  failure_reason: string | null;
  created_at: string;
  updated_at: string;
};

const SELECT_PAYOUT = `
  SELECT p.id, p.org_id, p.amount, p.currency, p.status, p.version, p.beneficiary_name,
         p.account_number, p.reference, p.created_by, c.name AS created_by_name,
         p.decided_by, d.name AS decided_by_name, p.reject_reason, p.failure_reason,
         p.created_at, p.updated_at
  FROM payouts p
  JOIN users c ON c.id = p.created_by
  LEFT JOIN users d ON d.id = p.decided_by`;

export function toPayout(r: PayoutRow): Payout {
  return {
    id: r.id,
    amount: r.amount,
    currency: r.currency,
    status: r.status,
    version: r.version,
    beneficiaryName: r.beneficiary_name,
    accountLast4: r.account_number.slice(-4),
    reference: r.reference,
    createdBy: { id: r.created_by, name: r.created_by_name },
    decidedBy: r.decided_by ? { id: r.decided_by, name: r.decided_by_name ?? r.decided_by } : null,
    rejectReason: r.reject_reason,
    failureReason: r.failure_reason,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

async function loadPayout(q: Queryable, orgId: string, payoutId: string): Promise<Payout> {
  const { rows } = await q.query<PayoutRow>(`${SELECT_PAYOUT} WHERE p.org_id = $1 AND p.id = $2`, [orgId, payoutId]);
  const row = rows[0];
  if (!row) throw new PayoutError(404, "payout_not_found");
  return toPayout(row);
}

/** Records a state change in the history and the outbox. Call inside the same transaction. */
export async function recordTransition(
  tx: Queryable,
  p: { orgId: string; payoutId: string; from: PayoutStatus | null; to: PayoutStatus; version: number },
  actorId: string | null,
  reason: string | null,
  now: string,
): Promise<void> {
  await tx.query(
    `INSERT INTO payout_events (payout_id, from_status, to_status, actor_id, reason, created_at)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [p.payoutId, p.from, p.to, actorId, reason, now],
  );
  // Same-status rows are history only (a retry); they don't change what clients show.
  if (p.from !== p.to) {
    await enqueueEvent(tx, p.orgId, { type: "payout", payoutId: p.payoutId, status: p.to, version: p.version }, now);
  }
}

export async function enqueueBalance(
  tx: Queryable,
  orgId: string,
  b: { currency: Currency; available: number; reserved: number },
  now: string,
): Promise<void> {
  await enqueueEvent(tx, orgId, { type: "balance", ...b }, now);
}

/** Canonical JSON (sorted keys), so the hash doesn't depend on property order. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export type CreateResult = { status: number; body: unknown; replayed: boolean };

export function createPayoutService(db: Db, clock: Clock = Date.now) {
  const iso = () => new Date(clock()).toISOString();

  /** Locks the pay-out row for the rest of the transaction. */
  async function lockPayout(tx: pg.PoolClient, orgId: string, payoutId: string) {
    const { rows } = await tx.query<{ status: PayoutStatus; version: number; created_by: string; amount: number; currency: Currency }>(
      "SELECT status, version, created_by, amount, currency FROM payouts WHERE org_id = $1 AND id = $2 FOR UPDATE",
      [orgId, payoutId],
    );
    const row = rows[0];
    if (!row) throw new PayoutError(404, "payout_not_found");
    return row;
  }

  function checkVersionAndTransition(row: { status: PayoutStatus; version: number }, version: number, to: PayoutStatus) {
    if (row.version !== version) throw new PayoutError(409, "version_conflict");
    if (!canTransition(row.status, to)) throw new PayoutError(409, "invalid_transition");
  }

  return {
    /**
     * Idempotent create. The key row, the pay-out and the stored response commit together.
     * A concurrent request with the same key blocks on the key's unique index until this
     * commits, then replays the stored response.
     */
    async create(orgId: string, userId: string, key: string, body: CreatePayoutBody): Promise<CreateResult> {
      // The user is part of the hash: someone else reusing your key gets a 422, not your response.
      const requestHash = createHash("sha256").update(canonical({ userId, body })).digest("hex");
      return withTransaction(db, async (tx) => {
        const now = iso();
        const claimed = await tx.query(
          `INSERT INTO idempotency_keys (org_id, key, request_hash, created_at) VALUES ($1, $2, $3, $4)
           ON CONFLICT (org_id, key) DO NOTHING`,
          [orgId, key, requestHash, now],
        );
        if (claimed.rowCount === 0) {
          const { rows } = await tx.query<{ request_hash: string; response_status: number | null; response_body: unknown }>(
            "SELECT request_hash, response_status, response_body FROM idempotency_keys WHERE org_id = $1 AND key = $2",
            [orgId, key],
          );
          const existing = rows[0];
          if (!existing || existing.request_hash !== requestHash) throw new PayoutError(422, "idempotency_key_reused");
          if (existing.response_status === null) throw new PayoutError(409, "idempotency_key_in_progress");
          return { status: existing.response_status, body: existing.response_body, replayed: true };
        }

        const id = `po_${randomUUID()}`;
        await tx.query(
          `INSERT INTO payouts (id, org_id, amount, currency, beneficiary_name, account_number, reference,
                                status, version, created_by, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending_approval', 1, $8, $9, $9)`,
          [id, orgId, body.amount, body.currency, body.beneficiaryName, body.accountNumber, body.reference, userId, now],
        );
        await recordTransition(tx, { orgId, payoutId: id, from: null, to: "pending_approval", version: 1 }, userId, null, now);

        const response = { payout: await loadPayout(tx, orgId, id) };
        await tx.query("UPDATE idempotency_keys SET response_status = 201, response_body = $3 WHERE org_id = $1 AND key = $2", [
          orgId,
          key,
          JSON.stringify(response),
        ]);
        return { status: 201, body: response, replayed: false };
      });
    },

    /** Whether this key was already used in the org (a replay or a 422, never a new pay-out). */
    async keyExists(orgId: string, key: string): Promise<boolean> {
      const { rowCount } = await db.query("SELECT 1 FROM idempotency_keys WHERE org_id = $1 AND key = $2", [orgId, key]);
      return (rowCount ?? 0) > 0;
    },

    /**
     * Four-eyes approval. In one transaction: lock the pay-out, refuse self-approval,
     * check version and transition, lock the balance row, check funds, and move the
     * amount from available to reserved.
     */
    async approve(orgId: string, userId: string, payoutId: string, version: number): Promise<Payout> {
      return withTransaction(db, async (tx) => {
        const now = iso();
        const p = await lockPayout(tx, orgId, payoutId);
        if (p.created_by === userId) throw new PayoutError(403, "self_approval_forbidden");
        checkVersionAndTransition(p, version, "approved");

        // Lock order everywhere: pay-out row first, then balance row. No deadlocks.
        const { rows } = await tx.query<{ available: number }>(
          "SELECT available FROM balances WHERE org_id = $1 AND currency = $2 FOR UPDATE",
          [orgId, p.currency],
        );
        if (!rows[0] || rows[0].available < p.amount) throw new PayoutError(409, "insufficient_funds");
        const { rows: balance } = await tx.query<{ available: number; reserved: number }>(
          `UPDATE balances SET available = available - $3, reserved = reserved + $3, updated_at = $4
           WHERE org_id = $1 AND currency = $2 RETURNING available, reserved`,
          [orgId, p.currency, p.amount, now],
        );

        const next = p.version + 1;
        await tx.query(
          `UPDATE payouts SET status = 'approved', version = $3, decided_by = $4, decided_at = $5,
                              next_attempt_at = $5, updated_at = $5
           WHERE org_id = $1 AND id = $2`,
          [orgId, payoutId, next, userId, now],
        );
        await recordTransition(tx, { orgId, payoutId, from: p.status, to: "approved", version: next }, userId, null, now);
        await enqueueBalance(tx, orgId, { currency: p.currency, ...balance[0]! }, now);
        return loadPayout(tx, orgId, payoutId);
      });
    },

    async reject(orgId: string, userId: string, payoutId: string, version: number, reason: string): Promise<Payout> {
      return withTransaction(db, async (tx) => {
        const now = iso();
        const p = await lockPayout(tx, orgId, payoutId);
        if (p.created_by === userId) throw new PayoutError(403, "self_rejection_forbidden");
        checkVersionAndTransition(p, version, "rejected");
        const next = p.version + 1;
        await tx.query(
          `UPDATE payouts SET status = 'rejected', version = $3, decided_by = $4, decided_at = $5,
                              reject_reason = $6, updated_at = $5
           WHERE org_id = $1 AND id = $2`,
          [orgId, payoutId, next, userId, now, reason],
        );
        await recordTransition(tx, { orgId, payoutId, from: p.status, to: "rejected", version: next }, userId, reason, now);
        return loadPayout(tx, orgId, payoutId);
      });
    },

    /** Only the creator, only while pending approval. No funds have moved yet. */
    async cancel(orgId: string, userId: string, payoutId: string, version: number): Promise<Payout> {
      return withTransaction(db, async (tx) => {
        const now = iso();
        const p = await lockPayout(tx, orgId, payoutId);
        if (p.created_by !== userId) throw new PayoutError(403, "not_creator");
        checkVersionAndTransition(p, version, "cancelled");
        const next = p.version + 1;
        await tx.query("UPDATE payouts SET status = 'cancelled', version = $3, updated_at = $4 WHERE org_id = $1 AND id = $2", [
          orgId,
          payoutId,
          next,
          now,
        ]);
        await recordTransition(tx, { orgId, payoutId, from: p.status, to: "cancelled", version: next }, userId, null, now);
        return loadPayout(tx, orgId, payoutId);
      });
    },

    /** Newest first, keyset on (created_at, id). */
    async list(orgId: string, opts: { status?: PayoutStatus; cursor?: string; limit: number }) {
      const args: (string | number)[] = [];
      const arg = (v: string | number) => `$${args.push(v)}`;
      const where = [`p.org_id = ${arg(orgId)}`];
      if (opts.status) where.push(`p.status = ${arg(opts.status)}`);
      if (opts.cursor) {
        const c = decodePayoutCursor(opts.cursor);
        if (!c) throw new PayoutError(400, "invalid_cursor");
        where.push(`(p.created_at, p.id) < (${arg(c.v)}::timestamptz, ${arg(c.id)})`);
      }
      const { rows } = await db.query<PayoutRow>(
        `${SELECT_PAYOUT} WHERE ${where.join(" AND ")} ORDER BY p.created_at DESC, p.id DESC LIMIT ${arg(opts.limit + 1)}`,
        args,
      );
      const hasMore = rows.length > opts.limit;
      const page = hasMore ? rows.slice(0, opts.limit) : rows;
      const last = page.at(-1);
      return {
        items: page.map(toPayout),
        nextCursor: hasMore && last ? encodePayoutCursor({ v: last.created_at, id: last.id }) : null,
      };
    },

    async get(orgId: string, payoutId: string): Promise<PayoutDetail> {
      const payout = await loadPayout(db, orgId, payoutId);
      const { rows } = await db.query<{
        id: number;
        from_status: PayoutStatus | null;
        to_status: PayoutStatus;
        actor_id: string | null;
        actor_name: string | null;
        reason: string | null;
        created_at: string;
      }>(
        `SELECT e.id, e.from_status, e.to_status, e.actor_id, u.name AS actor_name, e.reason, e.created_at
         FROM payout_events e LEFT JOIN users u ON u.id = e.actor_id
         WHERE e.payout_id = $1 ORDER BY e.id`,
        [payoutId],
      );
      const timeline: PayoutTimelineEntry[] = rows.map((r) => ({
        id: r.id,
        fromStatus: r.from_status,
        toStatus: r.to_status,
        actor: r.actor_id ? { id: r.actor_id, name: r.actor_name ?? r.actor_id } : null,
        reason: r.reason,
        at: r.created_at,
      }));
      return { payout, timeline };
    },
  };
}

export type PayoutService = ReturnType<typeof createPayoutService>;
