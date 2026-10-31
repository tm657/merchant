/** Supported currencies (ISO 4217 codes). */
export const CURRENCIES = ["USD", "IDR", "PHP"] as const;
export type Currency = (typeof CURRENCIES)[number];

/**
 * Minor-unit exponent per currency, from the ISO 4217 table: an amount of 1999 with
 * exponent 2 is 19.99. Every stored and transported amount is an integer in these units.
 */
export const CURRENCY_EXPONENT = {
  USD: 2,
  IDR: 2,
  PHP: 2,
} as const satisfies Record<Currency, number>;

/** Money is always integer minor units plus a currency code. Never a float. */
export type Money = { amount: number; currency: Currency };

export function isCurrency(value: string): value is Currency {
  return (CURRENCIES as readonly string[]).includes(value);
}
