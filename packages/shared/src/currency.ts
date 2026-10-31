/** Supported currencies (ISO 4217 codes). */
export const CURRENCIES = ["USD", "IDR", "PHP"] as const;
export type Currency = (typeof CURRENCIES)[number];

/**
 * Minor-unit exponent per currency: an amount of 1999 with exponent 2 is 19.99.
 * Every stored and transported amount is an integer in these units.
 *
 * IDR is 0 by our choice. ISO 4217 lists IDR with 2, but the rupiah has no subunit in
 * use and prices are whole rupiah, so we store whole rupiah (Rp15,000 is 15000).
 * Anything that exchanges IDR amounts with an ISO-4217-exponent system must convert.
 */
export const CURRENCY_EXPONENT = {
  USD: 2,
  IDR: 0,
  PHP: 2,
} as const satisfies Record<Currency, number>;

/** Money is always integer minor units plus a currency code. Never a float. */
export type Money = { amount: number; currency: Currency };

export function isCurrency(value: string): value is Currency {
  return (CURRENCIES as readonly string[]).includes(value);
}

/**
 * Whole major units to integer minor units (e.g. 5 USD is 500). Integer in, integer
 * out: never pass a fractional amount.
 */
export function majorToMinor(major: number, currency: Currency): number {
  if (!Number.isSafeInteger(major)) throw new RangeError(`major amount must be a safe integer, got ${major}`);
  const minor = major * 10 ** CURRENCY_EXPONENT[currency];
  if (!Number.isSafeInteger(minor)) throw new RangeError(`${major} ${currency} overflows minor units`);
  return minor;
}

export type MoneyInputResult = { ok: true; amount: number } | { ok: false; error: string };

/**
 * Parses what a person typed ("1,234.56") into integer minor units for `currency`,
 * using string arithmetic only: no floats are ever involved. Commas and spaces are
 * treated as thousands separators. More decimals than the currency has are rejected
 * (none at all for IDR), never rounded.
 */
export function parseMoneyInput(input: string, currency: Currency): MoneyInputResult {
  const exponent = CURRENCY_EXPONENT[currency];
  const cleaned = input.trim().replace(/[,\s]/g, "");
  const match = /^(\d+)(?:\.(\d*))?$/.exec(cleaned);
  if (!match) return { ok: false, error: "Enter an amount like 1,234.56" };
  const whole = match[1]!;
  const fraction = match[2] ?? "";
  if (fraction.length > exponent) {
    return {
      ok: false,
      error: exponent === 0 ? `${currency} amounts have no decimals` : `${currency} amounts have at most ${exponent} decimals`,
    };
  }
  const digits = (whole + fraction.padEnd(exponent, "0")).replace(/^0+(?=\d)/, "");
  const amount = Number(digits);
  if (!Number.isSafeInteger(amount)) return { ok: false, error: "That amount is too large" };
  if (amount <= 0) return { ok: false, error: "Enter an amount greater than zero" };
  return { ok: true, amount };
}
