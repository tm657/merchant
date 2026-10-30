import type Database from "better-sqlite3";
import type { FastifyBaseLogger } from "fastify";
import { randomUUID } from "node:crypto";
import { CURRENCIES, type Currency, type Status } from "./db.js";
import type { EventBus } from "./events.js";

const MIN_DELAY_MS = 3000;
const MAX_DELAY_MS = 5000;

const MERCHANTS = ["Grab", "Gojek", "Shopee", "Tokopedia", "Starbucks", "Jollibee", "Netflix", "Uber", "Airbnb"];

// Minor units, matching the seed's ranges.
const AMOUNT_RANGE: Record<Currency, [min: number, max: number]> = {
  USD: [100, 500_000],
  IDR: [1_000_000, 2_000_000_000],
  PHP: [5_000, 25_000_000],
};

const int = (min: number, max: number) => min + Math.floor(Math.random() * (max - min + 1));
const pick = <T>(xs: readonly T[]): T => xs[Math.floor(Math.random() * xs.length)] as T;

function pickStatus(): Status {
  const r = Math.random();
  return r < 0.8 ? "success" : r < 0.9 ? "pending" : "failed";
}

/** Inserts a random transaction every 3–5 s and publishes events after each commit. */
export function startSimulator(db: Database.Database, bus: EventBus, log: FastifyBaseLogger) {
  const listOrgs = db.prepare<[], { id: string }>("SELECT id FROM orgs");
  const insertTx = db.prepare(
    `INSERT INTO transactions (id, org_id, merchant, amount, currency, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  // Upsert, so an org with no balance row yet for this currency still works.
  const addToBalance = db.prepare<[string, Currency, number, string], { available: number }>(
    `INSERT INTO balances (org_id, currency, available, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT (org_id, currency) DO UPDATE
       SET available = available + excluded.available, updated_at = excluded.updated_at
     RETURNING available`,
  );

  // Insert and balance update commit together, or not at all.
  const recordTransaction = db.transaction((orgId: string) => {
    const currency = pick(CURRENCIES);
    const [min, max] = AMOUNT_RANGE[currency];
    const amount = int(min, max);
    const status = pickStatus();
    const now = new Date().toISOString();

    insertTx.run(`txn_${randomUUID()}`, orgId, pick(MERCHANTS), amount, currency, status, now);
    if (status !== "success") return null;
    const row = addToBalance.get(orgId, currency, amount, now);
    return row ? { currency, available: row.available } : null;
  });

  let timer: NodeJS.Timeout | undefined;
  let stopped = false;

  function tick() {
    try {
      const orgs = listOrgs.all();
      if (orgs.length > 0) {
        const orgId = pick(orgs).id;
        const balance = recordTransaction(orgId);
        // Only publish once the database transaction has committed.
        bus.publish(orgId, { type: "transactions", count: 1 });
        if (balance) bus.publish(orgId, { type: "balance", ...balance });
      }
    } catch (err) {
      log.error({ err }, "simulator tick failed");
    }
    schedule();
  }

  function schedule() {
    if (!stopped) timer = setTimeout(tick, int(MIN_DELAY_MS, MAX_DELAY_MS));
  }

  schedule();
  log.info("transaction simulator started");

  return {
    stop() {
      stopped = true;
      clearTimeout(timer);
    },
  };
}

