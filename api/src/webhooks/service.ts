import type {
  CreateWebhookEndpointBody,
  UpdateWebhookEndpointBody,
  WebhookDelivery,
  WebhookDeliveryStatus,
  WebhookEndpoint,
  WebhookEventType,
} from "@mini-payments/shared";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { audit, type AuditContext } from "../audit.js";
import type { Clock } from "../auth/sessions.js";
import { withTransaction, type Db, type Queryable } from "../db.js";
import { encryptSecret, generateWebhookSecret } from "./crypto.js";
import { BlockedTargetError, validateWebhookTarget, type TargetPolicy } from "./ssrf.js";

/** How long the old secret keeps signing after a rotation. */
export const ROTATION_GRACE_MS = 24 * 60 * 60 * 1000;

export class WebhookError extends Error {
  constructor(
    readonly status: 400 | 404 | 409,
    readonly code: string,
    readonly detail?: string,
  ) {
    super(code);
    this.name = "WebhookError";
  }
}

type EndpointRow = {
  id: string;
  url: string;
  description: string;
  enabled: boolean;
  events: WebhookEventType[];
  created_at: string;
  updated_at: string;
  secret_rotated_at: string | null;
  previous_secret_expires_at: string | null;
};
const ENDPOINT_COLUMNS =
  "id, url, description, enabled, events, created_at, updated_at, secret_rotated_at, previous_secret_expires_at";

/** `now`: the previous secret's expiry is only reported while it still signs. */
const toEndpoint = (r: EndpointRow, now: number): WebhookEndpoint => ({
  id: r.id,
  url: r.url,
  description: r.description,
  enabled: r.enabled,
  events: r.events,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  secretRotatedAt: r.secret_rotated_at,
  previousSecretExpiresAt:
    r.previous_secret_expires_at && Date.parse(r.previous_secret_expires_at) > now ? r.previous_secret_expires_at : null,
});

type DeliveryRow = {
  id: string;
  event_id: string;
  event_type: WebhookEventType;
  status: WebhookDeliveryStatus;
  attempts: number;
  next_attempt_at: string | null;
  last_attempt_at: string | null;
  last_response_code: number | null;
  last_error: string | null;
  delivered_at: string | null;
  redelivery_of: string | null;
  created_at: string;
};
const DELIVERY_COLUMNS =
  "id, event_id, event_type, status, attempts, next_attempt_at, last_attempt_at, last_response_code, last_error, delivered_at, redelivery_of, created_at";

const toDelivery = (r: DeliveryRow): WebhookDelivery => ({
  id: r.id,
  eventId: r.event_id,
  eventType: r.event_type,
  status: r.status,
  attempts: r.attempts,
  nextAttemptAt: r.next_attempt_at,
  lastAttemptAt: r.last_attempt_at,
  lastResponseCode: r.last_response_code,
  lastError: r.last_error,
  deliveredAt: r.delivered_at,
  redeliveryOf: r.redelivery_of,
  createdAt: r.created_at,
});

const deliveryCursorSchema = z.object({ v: z.iso.datetime(), id: z.string().min(1) });
const encodeCursor = (c: z.infer<typeof deliveryCursorSchema>) => Buffer.from(JSON.stringify(c)).toString("base64url");
function decodeCursor(raw: string) {
  try {
    return deliveryCursorSchema.parse(JSON.parse(Buffer.from(raw, "base64url").toString("utf8")));
  } catch {
    return null;
  }
}

/** Only the host goes in the audit log: paths and query strings can carry tokens. */
const hostForAudit = (url: string) => new URL(url).host;

export function createWebhookService(db: Db, key: Buffer, policy: TargetPolicy, clock: Clock = Date.now) {
  const iso = (ms = clock()) => new Date(ms).toISOString();

  async function checkTarget(url: string) {
    try {
      await validateWebhookTarget(url, policy);
    } catch (err) {
      if (err instanceof BlockedTargetError) throw new WebhookError(400, "webhook_url_not_allowed", err.message);
      throw err;
    }
  }

  async function lockEndpoint(tx: Queryable, orgId: string, id: string): Promise<EndpointRow> {
    const { rows } = await tx.query<EndpointRow>(
      `SELECT ${ENDPOINT_COLUMNS} FROM webhook_endpoints WHERE org_id = $1 AND id = $2 FOR UPDATE`,
      [orgId, id],
    );
    if (!rows[0]) throw new WebhookError(404, "webhook_endpoint_not_found");
    return rows[0];
  }

  return {
    async list(orgId: string): Promise<WebhookEndpoint[]> {
      const { rows } = await db.query<EndpointRow>(
        `SELECT ${ENDPOINT_COLUMNS} FROM webhook_endpoints WHERE org_id = $1 ORDER BY created_at DESC, id DESC`,
        [orgId],
      );
      return rows.map((r) => toEndpoint(r, clock()));
    },

    async get(orgId: string, id: string): Promise<WebhookEndpoint> {
      const { rows } = await db.query<EndpointRow>(`SELECT ${ENDPOINT_COLUMNS} FROM webhook_endpoints WHERE org_id = $1 AND id = $2`, [
        orgId,
        id,
      ]);
      if (!rows[0]) throw new WebhookError(404, "webhook_endpoint_not_found");
      return toEndpoint(rows[0], clock());
    },

    /** Returns the secret: the only time it is ever readable. */
    async create(orgId: string, ctx: AuditContext & { actorId: string }, body: CreateWebhookEndpointBody) {
      await checkTarget(body.url);
      const id = `we_${randomUUID()}`;
      const secret = generateWebhookSecret();
      return withTransaction(db, async (tx) => {
        const now = iso();
        const { rows } = await tx.query<EndpointRow>(
          `INSERT INTO webhook_endpoints (id, org_id, url, description, enabled, events, secret_enc, created_by, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $9)
           RETURNING ${ENDPOINT_COLUMNS}`,
          [id, orgId, body.url, body.description, body.enabled, body.events, encryptSecret(key, secret, id), ctx.actorId, now],
        );
        await audit(
          tx,
          ctx,
          {
            orgId,
            action: "webhook.endpoint.created",
            targetType: "webhook_endpoint",
            targetId: id,
            metadata: { host: hostForAudit(body.url), events: body.events, enabled: body.enabled },
          },
          now,
        );
        return { endpoint: toEndpoint(rows[0]!, clock()), secret };
      });
    },

    async update(orgId: string, ctx: AuditContext, id: string, patch: UpdateWebhookEndpointBody): Promise<WebhookEndpoint> {
      if (patch.url) await checkTarget(patch.url);
      return withTransaction(db, async (tx) => {
        const now = iso();
        const before = await lockEndpoint(tx, orgId, id);
        const { rows } = await tx.query<EndpointRow>(
          `UPDATE webhook_endpoints
           SET url = COALESCE($3, url), description = COALESCE($4, description),
               events = COALESCE($5, events), enabled = COALESCE($6, enabled), updated_at = $7
           WHERE org_id = $1 AND id = $2
           RETURNING ${ENDPOINT_COLUMNS}`,
          [orgId, id, patch.url ?? null, patch.description ?? null, patch.events ?? null, patch.enabled ?? null, now],
        );
        const after = rows[0]!;
        const changed = (["url", "description", "events", "enabled"] as const).filter((k) => patch[k] !== undefined);
        await audit(
          tx,
          ctx,
          {
            orgId,
            action: "webhook.endpoint.updated",
            targetType: "webhook_endpoint",
            targetId: id,
            metadata: {
              changed,
              ...(patch.url ? { hostBefore: hostForAudit(before.url), hostAfter: hostForAudit(after.url) } : {}),
              ...(patch.events ? { events: after.events } : {}),
              ...(patch.enabled !== undefined ? { enabled: after.enabled } : {}),
            },
          },
          now,
        );
        return toEndpoint(after, clock());
      });
    },

    /** New secret now; the previous one keeps signing for ROTATION_GRACE_MS. Returns the new secret, once. */
    async rotate(orgId: string, ctx: AuditContext, id: string) {
      const secret = generateWebhookSecret();
      return withTransaction(db, async (tx) => {
        const now = iso();
        await lockEndpoint(tx, orgId, id);
        const { rows } = await tx.query<EndpointRow>(
          `UPDATE webhook_endpoints
           SET previous_secret_enc = secret_enc, previous_secret_expires_at = $3,
               secret_enc = $4, secret_rotated_at = $5, updated_at = $5
           WHERE org_id = $1 AND id = $2
           RETURNING ${ENDPOINT_COLUMNS}`,
          [orgId, id, iso(clock() + ROTATION_GRACE_MS), encryptSecret(key, secret, id), now],
        );
        await audit(
          tx,
          ctx,
          {
            orgId,
            action: "webhook.endpoint.secret_rotated",
            targetType: "webhook_endpoint",
            targetId: id,
            metadata: { previousSecretExpiresAt: rows[0]!.previous_secret_expires_at },
          },
          now,
        );
        return { endpoint: toEndpoint(rows[0]!, clock()), secret };
      });
    },

    /** Deletes the endpoint and its deliveries. The audit entry stays. */
    async remove(orgId: string, ctx: AuditContext, id: string): Promise<void> {
      await withTransaction(db, async (tx) => {
        const now = iso();
        const before = await lockEndpoint(tx, orgId, id);
        await tx.query("DELETE FROM webhook_endpoints WHERE org_id = $1 AND id = $2", [orgId, id]);
        await audit(
          tx,
          ctx,
          {
            orgId,
            action: "webhook.endpoint.deleted",
            targetType: "webhook_endpoint",
            targetId: id,
            metadata: { host: hostForAudit(before.url), events: before.events },
          },
          now,
        );
      });
    },

    async listDeliveries(orgId: string, endpointId: string, opts: { status?: WebhookDeliveryStatus; cursor?: string; limit: number }) {
      await this.get(orgId, endpointId);
      const args: (string | number)[] = [];
      const arg = (v: string | number) => `$${args.push(v)}`;
      const where = [`org_id = ${arg(orgId)}`, `endpoint_id = ${arg(endpointId)}`];
      if (opts.status) where.push(`status = ${arg(opts.status)}`);
      if (opts.cursor) {
        const c = decodeCursor(opts.cursor);
        if (!c) throw new WebhookError(400, "invalid_cursor");
        where.push(`(created_at, id) < (${arg(c.v)}::timestamptz, ${arg(c.id)})`);
      }
      const { rows } = await db.query<DeliveryRow>(
        `SELECT ${DELIVERY_COLUMNS} FROM webhook_deliveries WHERE ${where.join(" AND ")}
         ORDER BY created_at DESC, id DESC LIMIT ${arg(opts.limit + 1)}`,
        args,
      );
      const hasMore = rows.length > opts.limit;
      const page = hasMore ? rows.slice(0, opts.limit) : rows;
      const last = page.at(-1);
      return { items: page.map(toDelivery), nextCursor: hasMore && last ? encodeCursor({ v: last.created_at, id: last.id }) : null };
    },

    /** Queues the same event (same bytes, same event id) again as a new delivery. */
    async redeliver(orgId: string, ctx: AuditContext, endpointId: string, deliveryId: string): Promise<WebhookDelivery> {
      return withTransaction(db, async (tx) => {
        const now = iso();
        const endpoint = await lockEndpoint(tx, orgId, endpointId);
        if (!endpoint.enabled) throw new WebhookError(409, "webhook_endpoint_disabled");
        const { rows: original } = await tx.query<{ event_id: string; event_type: string; body: string }>(
          "SELECT event_id, event_type, body FROM webhook_deliveries WHERE org_id = $1 AND endpoint_id = $2 AND id = $3",
          [orgId, endpointId, deliveryId],
        );
        if (!original[0]) throw new WebhookError(404, "webhook_delivery_not_found");
        const id = `whd_${randomUUID()}`;
        const { rows } = await tx.query<DeliveryRow>(
          `INSERT INTO webhook_deliveries (id, org_id, endpoint_id, event_id, event_type, body, status, attempts, next_attempt_at, redelivery_of, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, 'pending', 0, $7, $8, $7)
           RETURNING ${DELIVERY_COLUMNS}`,
          [id, orgId, endpointId, original[0].event_id, original[0].event_type, original[0].body, now, deliveryId],
        );
        await audit(
          tx,
          ctx,
          {
            orgId,
            action: "webhook.delivery.redelivered",
            targetType: "webhook_delivery",
            targetId: id,
            metadata: { endpointId, redeliveryOf: deliveryId, eventId: original[0].event_id, eventType: original[0].event_type },
          },
          now,
        );
        return toDelivery(rows[0]!);
      });
    },
  };
}

export type WebhookService = ReturnType<typeof createWebhookService>;
