import { CURRENCIES, type Currency, type Status } from "@mini-payments/shared";
import type { FastifyBaseLogger } from "fastify";
import { randomUUID } from "node:crypto";
import { amountRange } from "./amounts.js";
import { withTransaction, type Db } from "./db.js";
import { enqueueWebhookEvent } from "./outbox.js";
import type { EventBus } from "./events.js";

const MIN_DELAY_MS = 3000;
const MAX_DELAY_MS = 5000;

const MERCHANTS = ["Grab", "Gojek", "Shopee", "Tokopedia", "Starbucks", "Jollibee", "Netflix", "Uber", "Airbnb"];

const int = (min: number, max: number) => min + Math.floor(Math.random() * (max - min + 1));
const pick = <T>(xs: readonly T[]): T => xs[Math.floor(Math.random() * xs.length)] as T;

function pickStatus(): Status {
  const r = Math.random();
  return r < 0.8 ? "success" : r < 0.9 ? "pending" : "failed";
}

/**
 * Inserts a random transaction every 3–5 s and publishes events after each commit.
 * Events go through Redis, so SSE clients on every API instance see them. With several
 * instances, run the simulator on one only (SIMULATOR=off on the rest).
 */
export function startSimulator(db: Db, bus: EventBus, log: FastifyBaseLogger) {
  // Insert and balance update commit together, or not at all.
  function recordTransaction(orgId: string) {
    return withTransaction(db, async (tx) => {
      const currency = pick(CURRENCIES);
      const [min, max] = amountRange(currency);
      const amount = int(min, max);
      const status = pickStatus();
      const now = new Date().toISOString();

      const id = `txn_${randomUUID()}`;
      const merchant = pick(MERCHANTS);
      await tx.query(
        `INSERT INTO transactions (id, org_id, merchant, amount, currency, status, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [id, orgId, merchant, amount, currency, status, now],
      );
      // Webhooks go through the outbox; the SSE "transactions" event below stays direct.
      await enqueueWebhookEvent(
        tx,
        orgId,
        "transaction.created",
        { transaction: { id, type: "payin", merchant, amount, currency, status, createdAt: now, payoutId: null } },
        now,
      );
      if (status !== "success") return null;
      // Upsert, so an org with no balance row yet for this currency still works.
      const { rows } = await tx.query<{ available: number; reserved: number }>(
        `INSERT INTO balances (org_id, currency, available, updated_at) VALUES ($1, $2, $3, $4)
         ON CONFLICT (org_id, currency) DO UPDATE
           SET available = balances.available + excluded.available, updated_at = excluded.updated_at
         RETURNING available, reserved`,
        [orgId, currency, amount, now],
      );
      const row = rows[0];
      return row ? { currency: currency as Currency, available: row.available, reserved: row.reserved } : null;
    });
  }

  let timer: NodeJS.Timeout | undefined;
  let stopped = false;
  let running: Promise<void> = Promise.resolve();

  async function tick() {
    try {
      const { rows: orgs } = await db.query<{ id: string }>("SELECT id FROM orgs");
      if (orgs.length > 0) {
        const orgId = pick(orgs).id;
        const balance = await recordTransaction(orgId);
        // Only publish once the database transaction has committed.
        await bus.publish(orgId, { type: "transactions", count: 1 });
        if (balance) await bus.publish(orgId, { type: "balance", ...balance });
      }
    } catch (err) {
      log.error({ err }, "simulator tick failed");
    }
    schedule();
  }

  function schedule() {
    if (!stopped) {
      timer = setTimeout(() => {
        running = tick();
      }, int(MIN_DELAY_MS, MAX_DELAY_MS));
    }
  }

  schedule();
  log.info("transaction simulator started");

  return {
    /** Stops scheduling and resolves once any tick in progress has finished. */
    async stop() {
      stopped = true;
      clearTimeout(timer);
      await running;
    },
  };
}
