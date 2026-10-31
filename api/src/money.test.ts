import { CURRENCY_EXPONENT, majorToMinor } from "@mini-payments/shared";
import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { amountRange } from "./amounts.js";
import { parseBigint } from "./db.js";
import { makeTestApp } from "./test/helpers.js";

describe("money", () => {
  it("uses the exponent table: USD and PHP 2, IDR 0", () => {
    assert.deepEqual(CURRENCY_EXPONENT, { USD: 2, IDR: 0, PHP: 2 });
    assert.equal(majorToMinor(5, "USD"), 500);
    assert.equal(majorToMinor(15_000, "IDR"), 15_000);
    assert.throws(() => majorToMinor(1.5, "USD"));
  });

  it("seed and simulator ranges are realistic in each currency's minor units", () => {
    assert.deepEqual(amountRange("USD"), [100, 500_000]);
    assert.deepEqual(amountRange("IDR"), [10_000, 20_000_000]);
    assert.deepEqual(amountRange("PHP"), [5_000, 25_000_000]);
  });

  it("parses BIGINT exactly and refuses values a JS number can't hold", () => {
    assert.equal(parseBigint("9007199254740991"), Number.MAX_SAFE_INTEGER);
    assert.throws(() => parseBigint("9007199254740993"), RangeError);
  });

  it("returns BIGINT balances from Postgres as numbers", async () => {
    const t = await makeTestApp();
    await t.db.query("UPDATE balances SET available = 12345678901234 WHERE org_id = 'org_1'");
    const res = await t.get("/orgs/org_1/balances", await t.tokenFor("admin@test.com"));
    assert.deepEqual(res.json(), { balances: [{ currency: "USD", available: 12_345_678_901_234, reserved: 0 }] });
  });
});
