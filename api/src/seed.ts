import { CURRENCIES, DB_PATH, openDb, type Currency, type Status } from "./db.js";

const ORGS = [
  { id: "org_1", name: "Acme Retail" },
  { id: "org_2", name: "Nusantara Coffee" },
  { id: "org_3", name: "Manila Mobile" },
];
const TX_PER_ORG = 5000;
const DAYS_BACK = 180;

const MERCHANTS = [
  "Amazon", "Grab", "Gojek", "Shopee", "Tokopedia", "Lazada", "Starbucks", "Jollibee",
  "Netflix", "Spotify", "Apple", "Google Cloud", "Uber", "Airbnb", "Indomaret",
  "Alfamart", "SM Supermalls", "7-Eleven", "McDonald's", "Zalora", "Traveloka", "Agoda",
  "Steam", "Microsoft", "100% Pure_Co",
];

// Amount ranges in minor units (all three currencies use 2 decimal places in ISO 4217).
const AMOUNT_RANGE: Record<Currency, [min: number, max: number]> = {
  USD: [100, 500_000], // $1 – $5,000
  IDR: [1_000_000, 2_000_000_000], // Rp10,000 – Rp20,000,000
  PHP: [5_000, 25_000_000], // ₱50 – ₱250,000
};

// Small seeded PRNG (mulberry32) so every seed run produces the same data.
function mulberry32(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(42);
const int = (min: number, max: number) => min + Math.floor(rand() * (max - min + 1));
const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)] as T;

function pickStatus(): Status {
  const r = rand();
  return r < 0.8 ? "success" : r < 0.9 ? "pending" : "failed";
}

function pickAmount(currency: Currency): number {
  const [min, max] = AMOUNT_RANGE[currency];
  const amount = int(min, max);
  // ~30% are "price point" amounts rounded to 2 significant digits, so equal amounts
  // (ties on the amount sort) are common.
  if (rand() < 0.3) {
    const step = 10 ** Math.max(2, Math.floor(Math.log10(amount)) - 1);
    return Math.min(max, Math.max(min, Math.round(amount / step) * step));
  }
  return amount;
}

const db = openDb();
const now = Date.now();
// Second precision, so ~3% of rows share a timestamp with the row before (ties on created_at).
let lastTs = now;

const insertOrg = db.prepare("INSERT INTO orgs (id, name) VALUES (?, ?)");
const insertTx = db.prepare(
  `INSERT INTO transactions (id, org_id, merchant, amount, currency, status, created_at)
   VALUES (?, ?, ?, ?, ?, ?, ?)`,
);

db.transaction(() => {
  db.exec("DELETE FROM balances; DELETE FROM transactions; DELETE FROM orgs;");

  let n = 0;
  for (const org of ORGS) {
    insertOrg.run(org.id, org.name);
    for (let i = 0; i < TX_PER_ORG; i++) {
      n++;
      const ts =
        rand() < 0.03
          ? lastTs
          : Math.floor((now - rand() * DAYS_BACK * 86_400_000) / 1000) * 1000;
      lastTs = ts;
      const currency = pick(CURRENCIES);
      insertTx.run(
        `txn_${n.toString().padStart(6, "0")}`,
        org.id,
        pick(MERCHANTS),
        pickAmount(currency),
        currency,
        pickStatus(),
        new Date(ts).toISOString(),
      );
    }
  }

  db.prepare(
    `INSERT INTO balances (org_id, currency, available, updated_at)
     SELECT org_id, currency, SUM(amount), ?
     FROM transactions
     WHERE status = 'success'
     GROUP BY org_id, currency`,
  ).run(new Date(now).toISOString());
})();

const counts = db
  .prepare("SELECT org_id, status, COUNT(*) AS n FROM transactions GROUP BY org_id, status")
  .all();
console.log(`Seeded ${DB_PATH}`);
console.table(counts);
console.table(db.prepare("SELECT org_id, currency, available FROM balances").all());
db.close();
