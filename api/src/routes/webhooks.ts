import {
  apiWebhookDeliveriesQuerySchema,
  createWebhookEndpointBodySchema,
  updateWebhookEndpointBodySchema,
  webhookDeliveryIdSchema,
  webhookEndpointIdSchema,
} from "@mini-payments/shared";
import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import { WebhookError, type WebhookService } from "../webhooks/service.js";
import { badRequest } from "./common.js";
import { authorize, userContext } from "./orgAuth.js";

const endpointParams = z.object({ orgId: z.string(), endpointId: webhookEndpointIdSchema });
const deliveryParams = endpointParams.extend({ deliveryId: webhookDeliveryIdSchema });

async function handle(reply: FastifyReply, fn: () => Promise<unknown>) {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof WebhookError) {
      return reply.code(err.status).send({ error: err.code, ...(err.detail ? { message: err.detail } : {}) });
    }
    throw err;
  }
}

/** Every route needs webhooks:manage (admins). Secrets appear only in create and rotate. */
export function webhooksRoutes(app: FastifyInstance, service: WebhookService) {
  const base = "/orgs/:orgId/webhooks";

  app.get(base, async (req, reply) => {
    const auth = authorize(req, reply, "webhooks:manage");
    if (!auth) return reply;
    return { items: await service.list(auth.orgId) };
  });

  app.post(base, async (req, reply) => {
    const auth = authorize(req, reply, "webhooks:manage");
    if (!auth) return reply;
    const body = createWebhookEndpointBodySchema.safeParse(req.body);
    if (!body.success) return badRequest(reply, body.error);
    return handle(reply, async () => reply.code(201).send(await service.create(auth.orgId, userContext(req, auth), body.data)));
  });

  app.get(`${base}/:endpointId`, async (req, reply) => {
    const auth = authorize(req, reply, "webhooks:manage");
    if (!auth) return reply;
    const params = endpointParams.safeParse(req.params);
    if (!params.success) return reply.code(404).send({ error: "webhook_endpoint_not_found" });
    return handle(reply, async () => ({ endpoint: await service.get(auth.orgId, params.data.endpointId) }));
  });

  app.patch(`${base}/:endpointId`, async (req, reply) => {
    const auth = authorize(req, reply, "webhooks:manage");
    if (!auth) return reply;
    const params = endpointParams.safeParse(req.params);
    if (!params.success) return reply.code(404).send({ error: "webhook_endpoint_not_found" });
    const body = updateWebhookEndpointBodySchema.safeParse(req.body);
    if (!body.success) return badRequest(reply, body.error);
    return handle(reply, async () => ({
      endpoint: await service.update(auth.orgId, userContext(req, auth), params.data.endpointId, body.data),
    }));
  });

  app.delete(`${base}/:endpointId`, async (req, reply) => {
    const auth = authorize(req, reply, "webhooks:manage");
    if (!auth) return reply;
    const params = endpointParams.safeParse(req.params);
    if (!params.success) return reply.code(404).send({ error: "webhook_endpoint_not_found" });
    return handle(reply, async () => {
      await service.remove(auth.orgId, userContext(req, auth), params.data.endpointId);
      return reply.code(204).send();
    });
  });

  app.post(`${base}/:endpointId/rotate`, async (req, reply) => {
    const auth = authorize(req, reply, "webhooks:manage");
    if (!auth) return reply;
    const params = endpointParams.safeParse(req.params);
    if (!params.success) return reply.code(404).send({ error: "webhook_endpoint_not_found" });
    return handle(reply, () => service.rotate(auth.orgId, userContext(req, auth), params.data.endpointId));
  });

  app.get(`${base}/:endpointId/deliveries`, async (req, reply) => {
    const auth = authorize(req, reply, "webhooks:manage");
    if (!auth) return reply;
    const params = endpointParams.safeParse(req.params);
    if (!params.success) return reply.code(404).send({ error: "webhook_endpoint_not_found" });
    const query = apiWebhookDeliveriesQuerySchema.safeParse(req.query);
    if (!query.success) return badRequest(reply, query.error);
    return handle(reply, () => service.listDeliveries(auth.orgId, params.data.endpointId, query.data));
  });

  app.post(`${base}/:endpointId/deliveries/:deliveryId/redeliver`, async (req, reply) => {
    const auth = authorize(req, reply, "webhooks:manage");
    if (!auth) return reply;
    const params = deliveryParams.safeParse(req.params);
    if (!params.success) return reply.code(404).send({ error: "webhook_delivery_not_found" });
    return handle(reply, async () =>
      reply.code(201).send({
        delivery: await service.redeliver(auth.orgId, userContext(req, auth), params.data.endpointId, params.data.deliveryId),
      }),
    );
  });
}
