/**
 * Checks the ledger invariant on the database in DATABASE_URL:
 *   available + reserved = sum of successful transactions, per org and currency.
 * Prints every mismatch and exits 1 if there is any.
 *
 *   npm run db:check-ledger
 */
import { configSchema, parseEnv } from "../src/config.js";
import { createDb } from "../src/db.js";
import { ledgerMismatches } from "../src/ledger.js";

const { DATABASE_URL } = parseEnv(configSchema.pick({ DATABASE_URL: true }));
const db = createDb(DATABASE_URL, { max: 1 });
try {
  const mismatches = await ledgerMismatches(db);
  const { rows } = await db.query<{ n: number }>("SELECT count(*)::int AS n FROM balances");
  if (mismatches.length === 0) {
    console.log(`Ledger OK: ${rows[0]!.n} balance(s) match the sum of their successful transactions.`);
  } else {
    console.error("Ledger mismatch (amounts in minor units):");
    console.table(mismatches.map((m) => ({ ...m, difference: m.book - m.ledger })));
    process.exitCode = 1;
  }
} finally {
  await db.end();
}
