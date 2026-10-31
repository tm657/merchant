import { balanceEventSchema, exportEventSchema, payoutEventSchema, transactionsEventSchema } from "@mini-payments/shared";
import type { FastifyBaseLogger } from "fastify";
import type { Redis } from "ioredis";
import { z } from "zod";

export const orgEventSchema = z.discriminatedUnion("type", [
  balanceEventSchema.extend({ type: z.literal("balance") }),
  transactionsEventSchema.extend({ type: z.literal("transactions") }),
  payoutEventSchema.extend({ type: z.literal("payout") }),
  exportEventSchema.extend({ type: z.literal("export") }),
]);
export type OrgEvent = z.infer<typeof orgEventSchema>;

type Listener = (event: OrgEvent) => void;

export const orgChannel = (prefix: string, orgId: string) => `${prefix}events:org:${orgId}`;

/** Publishes to every API instance. Needs only a command connection (the worker uses this). */
export async function publishOrgEvent(redis: Redis, prefix: string, orgId: string, event: OrgEvent): Promise<void> {
  await redis.publish(orgChannel(prefix, orgId), JSON.stringify(orgEventSchema.parse(event)));
}

/**
 * Org-scoped pub/sub over Redis, so an event published by any API instance reaches SSE
 * clients on every instance. Each instance holds one subscriber connection and
 * subscribes to an org's channel only while it has local listeners for that org.
 */
export class EventBus {
  private readonly listeners = new Map<string, Set<Listener>>();
  /** Per org: the SUBSCRIBE in flight or done. Later listeners wait on the same one. */
  private readonly subscribed = new Map<string, Promise<unknown>>();

  constructor(
    private readonly publisher: Redis,
    private readonly subscriber: Redis,
    private readonly log: FastifyBaseLogger,
    private readonly prefix = "",
  ) {
    subscriber.on("message", (channel: string, message: string) => this.deliver(channel, message));
  }

  private channel(orgId: string): string {
    return orgChannel(this.prefix, orgId);
  }

  private deliver(channel: string, message: string) {
    const orgId = channel.startsWith(this.channel("")) ? channel.slice(this.channel("").length) : null;
    const set = orgId === null ? undefined : this.listeners.get(orgId);
    if (!set) return;
    let parsed: z.ZodSafeParseResult<OrgEvent>;
    try {
      parsed = orgEventSchema.safeParse(JSON.parse(message));
    } catch {
      parsed = { success: false } as z.ZodSafeParseResult<OrgEvent>;
    }
    if (!parsed.success) {
      this.log.warn({ channel }, "dropping malformed event");
      return;
    }
    for (const listener of set) listener(parsed.data);
  }

  /**
   * Resolves once this instance is subscribed, so no event published afterwards is
   * missed. Rejects if Redis is unavailable. Returns the unsubscribe function.
   */
  async subscribe(orgId: string, listener: Listener): Promise<() => void> {
    let set = this.listeners.get(orgId);
    if (!set) {
      set = new Set();
      this.listeners.set(orgId, set);
    }
    set.add(listener);

    let ready = this.subscribed.get(orgId);
    if (!ready) {
      ready = this.subscriber.subscribe(this.channel(orgId));
      this.subscribed.set(orgId, ready);
    }
    try {
      await ready;
    } catch (err) {
      this.remove(orgId, listener);
      throw err;
    }
    return () => this.remove(orgId, listener);
  }

  private remove(orgId: string, listener: Listener) {
    const set = this.listeners.get(orgId);
    if (!set?.delete(listener) || set.size > 0) return;
    this.listeners.delete(orgId);
    this.subscribed.delete(orgId);
    // Commands on one connection run in order, so a SUBSCRIBE sent after this still wins.
    this.subscriber.unsubscribe(this.channel(orgId)).catch((err: unknown) => {
      this.log.warn({ err, orgId }, "redis unsubscribe failed");
    });
  }

  /** Rejects if Redis is unavailable. */
  async publish(orgId: string, event: OrgEvent): Promise<void> {
    await publishOrgEvent(this.publisher, this.prefix, orgId, event);
  }
}
