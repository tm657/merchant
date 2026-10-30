import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { hashPassword } from "./auth/password.js";
import { CURRENCIES, DB_PATH, openDb, type Currency, type Role, type Status } from "./db.js";

const ORGS = [
  { id: "org_1", name: "Acme Retail" },
  { id: "org_2", name: "Nusantara Coffee" },
  { id: "org_3", name: "Manila Mobile" },
];
const TX_PER_ORG = 5000;

// Bob is in two orgs with different roles.
const USERS: { email: string; name: string; memberships: [orgId: string, role: Role][] }[] = [
  { email: "alice@example.com", name: "Alice Admin", memberships: [["org_1", "admin"]] },
  { email: "bob@example.com", name: "Bob Both", memberships: [["org_1", "finance"], ["org_2", "admin"]] },
  { email: "carol@example.com", name: "Carol Support", memberships: [["org_2", "support"]] },
  { email: "dave@example.com", name: "Dave Finance", memberships: [["org_3", "finance"]] },
];

// Passwords never live in the repo. They come from this gitignored file, which is
// created with random passwords on first run. Edit it to choose your own.
const PASSWORDS_FILE =
  process.env.SEED_USERS_FILE ?? join(dirname(fileURLToPath(import.meta.url)), "..", "seed-users.local.json");
const passwordsSchema = z.record(z.string(), z.string().min(12));

function loadPasswords(): Record<string, string> {
  if (!existsSync(PASSWORDS_FILE)) {
    const generated = Object.fromEntries(USERS.map((u) => [u.email, randomBytes(12).toString("base64url")]));
    writeFileSync(PASSWORDS_FILE, `${JSON.stringify(generated, null, 2)}\n`, { mode: 0o600 });
    console.log(`Generated seed passwords in ${PASSWORDS_FILE}`);
  }
  const passwords = passwordsSchema.parse(JSON.parse(readFileSync(PASSWORDS_FILE, "utf8")));
  for (const u of USERS) {
    if (!passwords[u.email]) throw new Error(`${PASSWORDS_FILE} has no password for ${u.email}`);
  }
  return passwords;
}

const passwords = loadPasswords();
const userHashes = await Promise.all(USERS.map((u) => hashPassword(passwords[u.email]!)));
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
  db.exec(`DELETE FROM sessions; DELETE FROM memberships; DELETE FROM users;
           DELETE FROM balances; DELETE FROM transactions; DELETE FROM orgs;`);

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

  const insertUser = db.prepare(
    "INSERT INTO users (id, email, name, password_hash, created_at) VALUES (?, ?, ?, ?, ?)",
  );
  const insertMembership = db.prepare("INSERT INTO memberships (user_id, org_id, role) VALUES (?, ?, ?)");
  USERS.forEach((u, i) => {
    const id = `usr_${i + 1}`;
    insertUser.run(id, u.email, u.name, userHashes[i], new Date(now).toISOString());
    for (const [orgId, role] of u.memberships) insertMembership.run(id, orgId, role);
  });

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
console.table(
  db.prepare("SELECT u.email, m.org_id, m.role FROM users u JOIN memberships m ON m.user_id = u.id ORDER BY u.email").all(),
);
console.log(`Passwords: ${PASSWORDS_FILE}`);
db.close();
