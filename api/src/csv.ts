/**
 * CSV cells (RFC 4180) with spreadsheet formula injection neutralised: a text cell that
 * starts with = + - @ tab or carriage return gets a leading ' so it can't run as a formula.
 * Every text cell goes through csvText, including ones that look like numbers (a
 * counterparty named "-12.34" is still text). Only amounts we generate ourselves with
 * formatMinorUnits use csvAmount, which checks the shape instead of prefixing.
 */
import { DECIMAL_AMOUNT_PATTERN } from "@mini-payments/shared";

const quote = (s: string) => (/[",\r\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s);

export function csvText(value: unknown): string {
  let s = value === null || value === undefined ? "" : typeof value === "string" ? value : JSON.stringify(value);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return quote(s);
}

/** A decimal amount from formatMinorUnits, written as is so it stays a number. Refuses anything else. */
export function csvAmount(decimal: string): string {
  if (!DECIMAL_AMOUNT_PATTERN.test(decimal)) throw new Error(`not a formatted amount: ${decimal}`);
  return decimal;
}

export const csvLine = (cells: string[]) => `${cells.join(",")}\r\n`;
