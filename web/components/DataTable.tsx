"use client";

import type { ReactNode } from "react";

export type SortState<K extends string> = { key: K; dir: "asc" | "desc" };

export type Column<T, K extends string> = {
  id: string;
  header: string;
  cell: (row: T) => ReactNode;
  /** Set to make the column sortable by this key. */
  sortKey?: K;
  align?: "left" | "right";
};

type Props<T, K extends string> = {
  columns: Column<T, K>[];
  rows: T[];
  sort: SortState<K>;
  onSortChange: (next: SortState<K>) => void;
  getRowId: (row: T) => string;
  renderEmpty: () => ReactNode;
  caption?: string;
  busy?: boolean;
};

/** Presentational only: no fetching, no sorting of its own. */
export function DataTable<T, K extends string>({
  columns,
  rows,
  sort,
  onSortChange,
  getRowId,
  renderEmpty,
  caption,
  busy = false,
}: Props<T, K>) {
  return (
    <div className="overflow-x-auto rounded-lg border border-zinc-200 dark:border-zinc-800">
      <table
        aria-busy={busy}
        className={`w-full border-collapse text-sm transition-opacity ${busy ? "opacity-60" : ""}`}
      >
        {caption && <caption className="sr-only">{caption}</caption>}
        <thead className="bg-zinc-50 dark:bg-zinc-900">
          <tr>
            {columns.map((col) => {
              const align = col.align === "right" ? "text-right" : "text-left";
              if (!col.sortKey) {
                return (
                  <th key={col.id} scope="col" className={`px-4 py-2 font-medium ${align}`}>
                    {col.header}
                  </th>
                );
              }
              const key = col.sortKey;
              const active = sort.key === key;
              const ariaSort = active ? (sort.dir === "asc" ? "ascending" : "descending") : "none";
              const next: SortState<K> = {
                key,
                dir: active && sort.dir === "desc" ? "asc" : "desc",
              };
              return (
                <th key={col.id} scope="col" aria-sort={ariaSort} className={`px-4 py-2 font-medium ${align}`}>
                  <button
                    type="button"
                    onClick={() => onSortChange(next)}
                    className="inline-flex items-center gap-1 rounded hover:underline focus-visible:outline-2"
                  >
                    {col.header}
                    <span aria-hidden="true" className={active ? "" : "text-zinc-400"}>
                      {active ? (sort.dir === "asc" ? "▲" : "▼") : "↕"}
                    </span>
                  </button>
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr>
              <td colSpan={columns.length} className="px-4 py-10 text-center">
                {renderEmpty()}
              </td>
            </tr>
          ) : (
            rows.map((row) => (
              <tr key={getRowId(row)} className="border-t border-zinc-200 dark:border-zinc-800">
                {columns.map((col) => (
                  <td
                    key={col.id}
                    className={`px-4 py-2 ${col.align === "right" ? "text-right tabular-nums" : ""}`}
                  >
                    {col.cell(row)}
                  </td>
                ))}
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}
