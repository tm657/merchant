import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { hashPassword } from "./auth/password.js";
import { CURRENCIES, majorToMinor, type Currency, type Role, type Status } from "@mini-payments/shared";
import { amountRange } from "./amounts.js";
import { migrationConfigSchema, parseEnv } from "./config.js";
import { createDb, withTransaction } from "./db.js";

// The seed resets tables, so it runs as the owner (MIGRATION_DATABASE_URL), not the app role.
const { MIGRATION_DATABASE_URL: DATABASE_URL } = parseEnv(migrationConfigSchema.pick({ MIGRATION_DATABASE_URL: true }));

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
  // Minor units, scaled by the currency's exponent (IDR is whole rupiah).
  const [min, max] = amountRange(currency);
  const amount = int(min, max);
  // ~30% are "price point" amounts rounded to 2 significant digits, so equal amounts
  // (ties on the amount sort) are common.
  if (rand() < 0.3) {
    const step = 10 ** Math.max(2, Math.floor(Math.log10(amount)) - 1);
    return Math.min(max, Math.max(min, Math.round(amount / step) * step));
  }
  return amount;
}

const now = Date.now();
// Second precision, so ~3% of rows share a timestamp with the row before (ties on created_at).
let lastTs = now;

// Generate every row first, in the same order as always, so the data is deterministic.
type TxRow = [id: string, orgId: string, merchant: string, amount: number, currency: Currency, status: Status, createdAt: string];
const txRows: TxRow[] = [];
let n = 0;
for (const org of ORGS) {
  for (let i = 0; i < TX_PER_ORG; i++) {
    n++;
    const ts =
      rand() < 0.03
        ? lastTs
        : Math.floor((now - rand() * DAYS_BACK * 86_400_000) / 1000) * 1000;
    lastTs = ts;
    const currency = pick(CURRENCIES);
    txRows.push([
      `txn_${n.toString().padStart(6, "0")}`,
      org.id,
      pick(MERCHANTS),
      pickAmount(currency),
      currency,
      pickStatus(),
      new Date(ts).toISOString(),
    ]);
  }
}

const DEMO_PAYOUTS: { major: number; currency: Currency; beneficiary: string; account: string; reference: string }[] = [
  { major: 250, currency: "USD", beneficiary: "Acme Supplies LLC", account: "US1234567890", reference: "Invoice 1042" },
  { major: 1_500_000, currency: "IDR", beneficiary: "PT Kopi Nusantara", account: "ID0098765432", reference: "Beans, March" },
  { major: 12_000, currency: "PHP", beneficiary: "Manila Logistics Inc", account: "PH5566778899", reference: "Freight" },
];

const BATCH = 1000;
const nowIso = new Date(now).toISOString();
const db = createDb(DATABASE_URL);

try {
  await withTransaction(db, async (tx) => {
    await tx.query(
      // audit_log is append-only and is never cleared, not even here.
      "TRUNCATE webhook_deliveries, webhook_endpoints, outbox, idempotency_keys, payout_events, payouts, sessions, memberships, users, balances, transactions, orgs",
    );

    for (const org of ORGS) await tx.query("INSERT INTO orgs (id, name) VALUES ($1, $2)", [org.id, org.name]);

    // One statement per batch: each column goes in as an array and unnest() turns them into rows.
    for (let i = 0; i < txRows.length; i += BATCH) {
      const batch = txRows.slice(i, i + BATCH);
      const column = (c: number) => batch.map((r) => r[c]);
      await tx.query(
        `INSERT INTO transactions (id, org_id, merchant, amount, currency, status, created_at)
         SELECT * FROM unnest($1::text[], $2::text[], $3::text[], $4::bigint[], $5::text[], $6::text[], $7::timestamptz[])`,
        [column(0), column(1), column(2), column(3), column(4), column(5), column(6)],
      );
    }

    for (const [i, u] of USERS.entries()) {
      const id = `usr_${i + 1}`;
      await tx.query("INSERT INTO users (id, email, name, password_hash, created_at) VALUES ($1, $2, $3, $4, $5)", [
        id,
        u.email,
        u.name,
        userHashes[i],
        nowIso,
      ]);
      for (const [orgId, role] of u.memberships) {
        await tx.query("INSERT INTO memberships (user_id, org_id, role) VALUES ($1, $2, $3)", [id, orgId, role]);
      }
    }

    await tx.query(
      `INSERT INTO balances (org_id, currency, available, updated_at)
       SELECT org_id, currency, SUM(amount), $1
       FROM transactions
       WHERE status = 'success'
       GROUP BY org_id, currency`,
      [nowIso],
    );

    // Demo pay-outs: Bob (finance) asks, so Alice (admin, org_1) can approve or reject.
    for (const [i, p] of DEMO_PAYOUTS.entries()) {
      const id = `po_demo-${i + 1}`;
      const at = new Date(now - (DEMO_PAYOUTS.length - i) * 60_000).toISOString();
      await tx.query(
        `INSERT INTO payouts (id, org_id, amount, currency, beneficiary_name, account_number, reference,
                              status, version, created_by, created_at, updated_at)
         VALUES ($1, 'org_1', $2, $3, $4, $5, $6, 'pending_approval', 1, 'usr_2', $7, $7)`,
        [id, majorToMinor(p.major, p.currency), p.currency, p.beneficiary, p.account, p.reference, at],
      );
      await tx.query(
        `INSERT INTO payout_events (payout_id, from_status, to_status, actor_id, created_at)
         VALUES ($1, NULL, 'pending_approval', 'usr_2', $2)`,
        [id, at],
      );
    }
  });

  console.table((await db.query("SELECT id, currency, amount, beneficiary_name, status FROM payouts ORDER BY created_at")).rows);
  const counts = await db.query(
    "SELECT org_id, status, COUNT(*) AS n FROM transactions GROUP BY org_id, status ORDER BY org_id, status",
  );
  console.log(`Seeded ${new URL(DATABASE_URL).pathname.slice(1)} on ${new URL(DATABASE_URL).host}`);
  console.table(counts.rows);
  console.table((await db.query("SELECT org_id, currency, available FROM balances ORDER BY org_id, currency")).rows);
  console.table(
    (await db.query("SELECT u.email, m.org_id, m.role FROM users u JOIN memberships m ON m.user_id = u.id ORDER BY u.email, m.org_id")).rows,
  );
  console.log(`Passwords: ${PASSWORDS_FILE}`);
} finally {
  await db.end();
}
