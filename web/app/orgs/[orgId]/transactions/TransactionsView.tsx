"use client";

import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useSearchParams } from "next/navigation";
import { useCallback, useMemo, useState } from "react";
import { DataTable, type Column, type SortState } from "@/components/DataTable";
import { FilterBar, type FilterPatch } from "@/components/FilterBar";
import { TableSkeleton } from "@/components/TableSkeleton";
import { formatDateTime, formatMoney } from "@/lib/format";
import {
  errorBodySchema,
  filtersToSearch,
  pageQuery,
  parseFilters,
  transactionsPageSchema,
  type Filters,
  type SortKey,
  type Status,
  type Transaction,
  type TransactionsPage,
} from "@/lib/schemas";

class BffError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
  }
}

async function getTransactions(
  orgId: string,
  filters: Filters,
  cursor: string | null,
  signal: AbortSignal,
): Promise<TransactionsPage> {
  const qs = pageQuery(filters, cursor).toString();
  const res = await fetch(`/api/orgs/${encodeURIComponent(orgId)}/transactions?${qs}`, { signal });
  const body: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    throw new BffError(res.status, errorBodySchema.safeParse(body).data?.error ?? "unknown_error");
  }
  return transactionsPageSchema.parse(body);
}

const ERROR_MESSAGES: Record<string, string> = {
  org_not_found: "This organization does not exist.",
  upstream_unavailable: "The payments service is unreachable. Is the API running?",
  upstream_timeout: "The payments service took too long to respond.",
  invalid_cursor: "This page link is no longer valid.",
  cursor_sort_mismatch: "This page link is no longer valid.",
};

function errorMessage(err: unknown): string {
  if (err instanceof BffError) return ERROR_MESSAGES[err.code] ?? `Request failed (${err.status}).`;
  return "Something went wrong while loading transactions.";
}

const STATUS_STYLES: Record<Status, string> = {
  success: "bg-emerald-50 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300",
  pending: "bg-amber-50 text-amber-700 dark:bg-amber-950 dark:text-amber-300",
  failed: "bg-red-50 text-red-700 dark:bg-red-950 dark:text-red-300",
};

const COLUMNS: Column<Transaction, SortKey>[] = [
  { id: "date", header: "Date", sortKey: "createdAt", cell: (t) => formatDateTime(t.createdAt) },
  { id: "merchant", header: "Merchant", cell: (t) => t.merchant },
  {
    id: "status",
    header: "Status",
    cell: (t) => (
      <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_STYLES[t.status]}`}>
        {t.status}
      </span>
    ),
  },
  {
    id: "amount",
    header: "Amount",
    sortKey: "amount",
    align: "right",
    cell: (t) => formatMoney(t.amount, t.currency),
  },
];

const getRowId = (t: Transaction) => t.id;

type Props = {
  orgId: string;
  /** First page rendered on the server, or null if that fetch failed. */
  initialPage: TransactionsPage | null;
  /** The filters the server used for `initialPage`, serialized. */
  initialFiltersKey: string;
};

export function TransactionsView({ orgId, initialPage, initialFiltersKey }: Props) {
  // The URL is the source of truth for filters and sort.
  const searchParams = useSearchParams();
  const filters = useMemo(() => parseFilters(searchParams), [searchParams]);
  const filtersKey = filtersToSearch(filters).toString();

  // Cursor stack for Prev/Next. It belongs to one set of filters: when the filters
  // change (including via back/forward), it no longer matches and counts as empty.
  const [pager, setPager] = useState<{ key: string; stack: string[] }>({ key: filtersKey, stack: [] });
  const stack = pager.key === filtersKey ? pager.stack : [];
  const cursor = stack.at(-1) ?? null;

  const canUseServerPage = cursor === null && filtersKey === initialFiltersKey && initialPage !== null;

  const query = useQuery({
    queryKey: ["transactions", orgId, filters, cursor],
    queryFn: ({ signal }) => getTransactions(orgId, filters, cursor, signal),
    placeholderData: keepPreviousData,
    initialData: canUseServerPage ? initialPage : undefined,
    // 4xx answers (bad cursor, unknown org) will not change on retry.
    retry: (count, err) => !(err instanceof BffError && err.status < 500) && count < 1,
  });

  // Reads the live URL so this stays stable (FilterBar's debounce depends on it).
  const updateUrl = useCallback((patch: Partial<Filters>, opts?: { replace?: boolean }) => {
    const current = parseFilters(new URLSearchParams(window.location.search));
    const qs = filtersToSearch({ ...current, ...patch }).toString();
    const url = qs ? `?${qs}` : window.location.pathname;
    if (opts?.replace) window.history.replaceState(null, "", url);
    else window.history.pushState(null, "", url);
  }, []);

  const onFilterChange = useCallback(
    (patch: FilterPatch, opts?: { replace?: boolean }) => updateUrl(patch, opts),
    [updateUrl],
  );
  const onSortChange = useCallback(
    (next: SortState<SortKey>) => updateUrl({ sort: next.key, dir: next.dir }),
    [updateUrl],
  );

  const setStack = (next: string[]) => setPager({ key: filtersKey, stack: next });
  const page = query.data;
  const loadingNewPage = query.isFetching && query.isPlaceholderData;

  return (
    <div className="flex flex-col gap-4">
      <FilterBar filters={filters} onChange={onFilterChange} />

      <p aria-live="polite" className="sr-only">
        {loadingNewPage ? "Loading transactions…" : ""}
      </p>

      {query.isError ? (
        <div role="alert" className="flex flex-col items-start gap-3 rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-200">
          <p>{errorMessage(query.error)}</p>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => void query.refetch()}
              className="rounded-md bg-red-700 px-3 py-1.5 font-medium text-white hover:bg-red-800"
            >
              Retry
            </button>
            {stack.length > 0 && (
              <button
                type="button"
                onClick={() => setStack([])}
                className="rounded-md px-3 py-1.5 font-medium hover:bg-red-100 dark:hover:bg-red-900"
              >
                Back to first page
              </button>
            )}
          </div>
        </div>
      ) : !page ? (
        <TableSkeleton />
      ) : (
        <>
          <DataTable
            caption="Transactions"
            columns={COLUMNS}
            rows={page.items}
            sort={{ key: filters.sort, dir: filters.dir }}
            onSortChange={onSortChange}
            getRowId={getRowId}
            busy={loadingNewPage}
            renderEmpty={() => (
              <div className="flex flex-col items-center gap-1 text-zinc-500">
                <p className="font-medium text-zinc-700 dark:text-zinc-300">No transactions found</p>
                <p>Try changing or clearing the filters.</p>
              </div>
            )}
          />

          <nav aria-label="Pagination" className="flex items-center justify-between text-sm">
            <span className="text-zinc-500">
              Page {stack.length + 1}
              {loadingNewPage && " · Loading…"}
            </span>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => setStack(stack.slice(0, -1))}
                disabled={stack.length === 0 || loadingNewPage}
                className="rounded-md border border-zinc-300 px-3 py-1.5 font-medium disabled:opacity-40 dark:border-zinc-700"
              >
                Prev
              </button>
              <button
                type="button"
                onClick={() => page.nextCursor && setStack([...stack, page.nextCursor])}
                disabled={!page.nextCursor || loadingNewPage}
                className="rounded-md border border-zinc-300 px-3 py-1.5 font-medium disabled:opacity-40 dark:border-zinc-700"
              >
                Next
              </button>
            </div>
          </nav>
        </>
      )}
    </div>
  );
}
