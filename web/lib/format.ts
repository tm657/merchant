// Display-only formatting. A fixed locale and UTC keep server and browser output identical,
// which avoids hydration mismatches.
const LOCALE = "en-US";

const moneyFormatters = new Map<string, Intl.NumberFormat>();

function moneyFormatter(currency: string): Intl.NumberFormat {
  let f = moneyFormatters.get(currency);
  if (!f) {
    f = new Intl.NumberFormat(LOCALE, { style: "currency", currency });
    moneyFormatters.set(currency, f);
  }
  return f;
}

/** `amount` is integer minor units. Division happens only here, at render time. */
export function formatMoney(amount: number, currency: string): string {
  return moneyFormatter(currency).format(amount / 100);
}

const dateFormatter = new Intl.DateTimeFormat(LOCALE, {
  dateStyle: "medium",
  timeStyle: "short",
  timeZone: "UTC",
});

export function formatDateTime(iso: string): string {
  return `${dateFormatter.format(new Date(iso))} UTC`;
}
