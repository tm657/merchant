import { CURRENCY_EXPONENT, type Currency, type TransactionType } from "@mini-payments/shared";

export const TRANSACTION_TYPE_LABEL: Record<TransactionType, string> = { payin: "Pay-in", payout: "Pay-out" };

// Display-only formatting. A fixed locale and UTC keep server and browser output identical,
// which avoids hydration mismatches.
const LOCALE = "en-US";

const moneyFormatters = new Map<Currency, Intl.NumberFormat>();

function moneyFormatter(currency: Currency): Intl.NumberFormat {
  let f = moneyFormatters.get(currency);
  if (!f) {
    // Show exactly as many decimals as the currency exponent table says (IDR: none).
    const digits = CURRENCY_EXPONENT[currency];
    f = new Intl.NumberFormat(LOCALE, {
      style: "currency",
      currency,
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
    });
    moneyFormatters.set(currency, f);
  }
  return f;
}

/** `amount` is integer minor units. Converting to major units happens only here, at render time. */
export function formatMoney(amount: number, currency: Currency): string {
  return moneyFormatter(currency).format(amount / 10 ** CURRENCY_EXPONENT[currency]);
}

const dateFormatter = new Intl.DateTimeFormat(LOCALE, {
  dateStyle: "medium",
  timeStyle: "short",
  timeZone: "UTC",
});

export function formatDateTime(iso: string): string {
  return `${dateFormatter.format(new Date(iso))} UTC`;
}
