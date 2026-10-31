import { z } from "zod";
import { payoutSchema } from "./payouts.ts";
import { transactionSchema } from "./schemas.ts";

export const WEBHOOK_EVENT_TYPES = [
  "payout.created",
  "payout.approved",
  "payout.rejected",
  "payout.cancelled",
  "payout.processing",
  "payout.paid",
  "payout.failed",
  "transaction.created",
] as const;
export type WebhookEventType = (typeof WEBHOOK_EVENT_TYPES)[number];

export const WEBHOOK_SIGNATURE_HEADER = "webhook-signature";
export const WEBHOOK_ID_HEADER = "webhook-id";
export const WEBHOOK_EVENT_HEADER = "webhook-event";
/** Receivers should refuse signatures older than this (replay protection). */
export const WEBHOOK_TOLERANCE_SECONDS = 300;
export const WEBHOOK_MAX_ATTEMPTS = 8;

export const webhookEndpointIdSchema = z.string().regex(/^we_[A-Za-z0-9-]{1,64}$/);
export const webhookDeliveryIdSchema = z.string().regex(/^whd_[A-Za-z0-9-]{1,64}$/);

const eventsSchema = z
  .array(z.enum(WEBHOOK_EVENT_TYPES))
  .min(1, "Pick at least one event")
  .refine((xs) => new Set(xs).size === xs.length, "Each event only once");

/** Syntax only. The API also enforces HTTPS in production and blocks private addresses. */
const urlSchema = z.url({ protocol: /^https?$/, message: "Enter an http(s) URL" }).max(2048);

export const createWebhookEndpointBodySchema = z
  .object({
    url: urlSchema,
    description: z.string().trim().max(200).default(""),
    events: eventsSchema,
    enabled: z.boolean().default(true),
  })
  .strict();
export type CreateWebhookEndpointBody = z.infer<typeof createWebhookEndpointBodySchema>;

export const updateWebhookEndpointBodySchema = z
  .object({
    url: urlSchema.optional(),
    description: z.string().trim().max(200).optional(),
    events: eventsSchema.optional(),
    enabled: z.boolean().optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, "Change at least one field");
export type UpdateWebhookEndpointBody = z.infer<typeof updateWebhookEndpointBodySchema>;

/** No part of the secret is ever in here. */
export const webhookEndpointSchema = z.object({
  id: webhookEndpointIdSchema,
  url: z.string(),
  description: z.string(),
  enabled: z.boolean(),
  events: z.array(z.enum(WEBHOOK_EVENT_TYPES)),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  secretRotatedAt: z.iso.datetime().nullable(),
  /** Set only while the previous secret still signs too (24 h after a rotation). */
  previousSecretExpiresAt: z.iso.datetime().nullable(),
});
export type WebhookEndpoint = z.infer<typeof webhookEndpointSchema>;

export const webhookEndpointListSchema = z.object({ items: z.array(webhookEndpointSchema) });
export const webhookEndpointResponseSchema = z.object({ endpoint: webhookEndpointSchema });
/** Create and rotate only: the one and only time the secret is shown. */
export const webhookSecretResponseSchema = z.object({ endpoint: webhookEndpointSchema, secret: z.string() });

export const WEBHOOK_DELIVERY_STATUSES = ["pending", "delivering", "succeeded", "dead"] as const;
export type WebhookDeliveryStatus = (typeof WEBHOOK_DELIVERY_STATUSES)[number];

export const webhookDeliverySchema = z.object({
  id: webhookDeliveryIdSchema,
  eventId: z.string(),
  eventType: z.enum(WEBHOOK_EVENT_TYPES),
  status: z.enum(WEBHOOK_DELIVERY_STATUSES),
  attempts: z.number().int(),
  nextAttemptAt: z.iso.datetime().nullable(),
  lastAttemptAt: z.iso.datetime().nullable(),
  lastResponseCode: z.number().int().nullable(),
  lastError: z.string().nullable(),
  deliveredAt: z.iso.datetime().nullable(),
  redeliveryOf: z.string().nullable(),
  createdAt: z.iso.datetime(),
});
export type WebhookDelivery = z.infer<typeof webhookDeliverySchema>;

export const webhookDeliveriesPageSchema = z.object({
  items: z.array(webhookDeliverySchema),
  nextCursor: z.string().nullable(),
});
export type WebhookDeliveriesPage = z.infer<typeof webhookDeliveriesPageSchema>;
export const webhookDeliveryResponseSchema = z.object({ delivery: webhookDeliverySchema });

const deliveryListFields = {
  status: z.enum(WEBHOOK_DELIVERY_STATUSES).optional(),
  cursor: z.string().min(1).max(500).optional(),
};
export const webhookDeliveriesQuerySchema = z
  .object({ ...deliveryListFields, limit: z.coerce.number().int().min(1).max(100).optional() })
  .strict();
export const apiWebhookDeliveriesQuerySchema = z
  .object({ ...deliveryListFields, limit: z.coerce.number().int().min(1).max(100).default(25) })
  .strict();

const envelope = { id: z.string(), createdAt: z.iso.datetime(), orgId: z.string() };

/** The JSON body every webhook request carries. Amounts are integer minor units. */
export const webhookEventSchema = z.union([
  z.object({
    ...envelope,
    type: z.enum(WEBHOOK_EVENT_TYPES.filter((t) => t.startsWith("payout.")) as [WebhookEventType, ...WebhookEventType[]]),
    data: z.object({ payout: payoutSchema }),
  }),
  z.object({ ...envelope, type: z.literal("transaction.created"), data: z.object({ transaction: transactionSchema }) }),
]);
export type WebhookEvent = z.infer<typeof webhookEventSchema>;
