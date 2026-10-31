"use client";

import { useEffect, useId, useState } from "react";
import { CURRENCIES, STATUSES } from "@mini-payments/shared";
import type { Filters } from "@/lib/filters";

export type FilterPatch = Partial<Omit<Filters, "sort" | "dir">>;

type Props = {
  filters: Filters;
  /** Must be stable across renders: the debounce effect depends on it. */
  onChange: (patch: FilterPatch, opts?: { replace?: boolean }) => void;
};

const SEARCH_DEBOUNCE_MS = 300;

const field = "flex flex-col gap-1 text-xs font-medium text-zinc-600 dark:text-zinc-400";
const control =
  "h-9 rounded-md border border-zinc-300 bg-white px-2 text-sm text-zinc-900 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100";

export function FilterBar({ filters, onChange }: Props) {
  const id = useId();
  const urlQ = filters.q ?? "";

  // The search box keeps its own draft while typing. When the URL changes from
  // elsewhere (back button, "Clear filters"), the draft follows it.
  const [draft, setDraft] = useState(urlQ);
  const [syncedQ, setSyncedQ] = useState(urlQ);
  if (urlQ !== syncedQ) {
    setSyncedQ(urlQ);
    setDraft(urlQ);
  }

  useEffect(() => {
    const next = draft.trim();
    if (next === urlQ) return;
    const t = setTimeout(() => onChange({ q: next || undefined }, { replace: true }), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [draft, urlQ, onChange]);

  const hasFilters = Boolean(filters.status || filters.currency || filters.from || filters.to || filters.q);

  return (
    <form
      role="search"
      aria-label="Filter transactions"
      onSubmit={(e) => e.preventDefault()}
      className="flex flex-wrap items-end gap-3"
    >
      <label className={field} htmlFor={`${id}-q`}>
        Merchant
        <input
          id={`${id}-q`}
          type="search"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="Search merchant…"
          maxLength={100}
          className={`${control} w-56`}
        />
      </label>

      <label className={field} htmlFor={`${id}-status`}>
        Status
        <select
          id={`${id}-status`}
          value={filters.status ?? ""}
          onChange={(e) => onChange({ status: (e.target.value || undefined) as Filters["status"] })}
          className={control}
        >
          <option value="">All</option>
          {STATUSES.map((s) => (
            <option key={s} value={s}>
              {s[0].toUpperCase() + s.slice(1)}
            </option>
          ))}
        </select>
      </label>

      <label className={field} htmlFor={`${id}-currency`}>
        Currency
        <select
          id={`${id}-currency`}
          value={filters.currency ?? ""}
          onChange={(e) => onChange({ currency: (e.target.value || undefined) as Filters["currency"] })}
          className={control}
        >
          <option value="">All</option>
          {CURRENCIES.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
      </label>

      <label className={field} htmlFor={`${id}-from`}>
        From (UTC)
        <input
          id={`${id}-from`}
          type="date"
          value={filters.from ?? ""}
          max={filters.to}
          onChange={(e) => onChange({ from: e.target.value || undefined })}
          className={control}
        />
      </label>

      <label className={field} htmlFor={`${id}-to`}>
        To (UTC)
        <input
          id={`${id}-to`}
          type="date"
          value={filters.to ?? ""}
          min={filters.from}
          onChange={(e) => onChange({ to: e.target.value || undefined })}
          className={control}
        />
      </label>

      {hasFilters && (
        <button
          type="button"
          onClick={() =>
            onChange({ status: undefined, currency: undefined, from: undefined, to: undefined, q: undefined })
          }
          className="h-9 rounded-md px-3 text-sm text-zinc-700 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800"
        >
          Clear filters
        </button>
      )}
    </form>
  );
}
