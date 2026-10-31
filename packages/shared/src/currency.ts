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
