import { majorToMinor, type Currency } from "@mini-payments/shared";

// Realistic transaction sizes in whole major units, shared by the seed and the simulator.
const RANGE_MAJOR: Record<Currency, [min: number, max: number]> = {
  USD: [1, 5_000], // $1 – $5,000
  IDR: [10_000, 20_000_000], // Rp10,000 – Rp20,000,000
  PHP: [50, 250_000], // ₱50 – ₱250,000
};

/** The range in integer minor units, using the currency exponent table. */
export function amountRange(currency: Currency): [min: number, max: number] {
  const [min, max] = RANGE_MAJOR[currency];
  return [majorToMinor(min, currency), majorToMinor(max, currency)];
}
