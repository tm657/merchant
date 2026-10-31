"use client";

import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { DataTable, type Column, type SortState } from "@/components/DataTable";
import { FilterBar, type FilterPatch } from "@/components/FilterBar";
import { useOrgEvents } from "@/components/OrgEvents";
import { TableSkeleton } from "@/components/TableSkeleton";
import { formatDateTime, formatMoney, TRANSACTION_TYPE_LABEL } from "@/lib/format";
import { exportErrorMessage } from "@/lib/admin-messages";
import { BffError, bffGet, bffPostJson } from "@/lib/bff-client";
import {
  transactionsPageSchema,
  type SortKey,
  type Status,
  type Transaction,
  type TransactionType,
  type TransactionsPage,
  exportJobResponseSchema,
} from "@mini-payments/shared";
import { filtersToSearch, pageQuery, parseFilters, type Filters } from "@/lib/filters";

function getTransactions(
  orgId: string,
  filters: Filters,
  cursor: string | null,
  signal: AbortSignal,
): Promise<TransactionsPage> {
  const qs = pageQuery(filters, cursor).toString();
  return bffGet(`/api/orgs/${encodeURIComponent(orgId)}/transactions?${qs}`, transactionsPageSchema, signal);
}

const ERROR_MESSAGES: Record<string, string> = {
  org_not_found: "This organization does not exist.",
  forbidden: "You don't have access to this organization.",
  upstream_unavailable: "The payments service is unreachable. Is the API running?",
  upstream_timeout: "The payments service took too long to respond.",
  invalid_cursor: "This page link is no longer valid.",
  cursor_sort_mismatch: "This page link is no longer valid.",
};

function errorMessage(err: unknown): string {
  if (err instanceof BffError) return ERROR_MESSAGES[err.code] ?? `Request failed (${err.status}).`;
  return "Something went wrong while loading transactions.";
}

const TYPE_STYLES: Record<TransactionType, string> = {
  payin: "bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300",
  payout: "bg-sky-50 text-sky-800 dark:bg-sky-950 dark:text-sky-300",
};

const STATUS_STYLES: Record<Status, string> = {
  success: "bg-emerald-50 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300",
  pending: "bg-amber-50 text-amber-700 dark:bg-amber-950 dark:text-amber-300",
  failed: "bg-red-50 text-red-700 dark:bg-red-950 dark:text-red-300",
};

/** Pay-out entries link to their pay-out, which needs the org. */
function columnsFor(orgId: string): Column<Transaction, SortKey>[] {
  return [
    { id: "date", header: "Date", sortKey: "createdAt", cell: (t) => formatDateTime(t.createdAt) },
    {
      id: "type",
      header: "Type",
      cell: (t) => (
        <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${TYPE_STYLES[t.type]}`}>{TRANSACTION_TYPE_LABEL[t.type]}</span>
      ),
    },
    {
      id: "counterparty",
      header: "Counterparty",
      cell: (t) =>
        t.payoutId ? (
          // A pay-out entry: open the pay-out it books.
          <Link href={`/orgs/${encodeURIComponent(orgId)}/payouts?payout=${encodeURIComponent(t.payoutId)}`} className="underline-offset-2 hover:underline">
            {t.merchant}
          </Link>
        ) : (
          t.merchant
        ),
    },
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
}

const getRowId = (t: Transaction) => t.id;

type Props = {
  orgId: string;
  /** Show "Export these filters" (reports:export). The API checks the role again. */
  canExport: boolean;
  /** First page rendered on the server, or null if that fetch failed. */
  initialPage: TransactionsPage | null;
  /** The filters the server used for `initialPage`, serialized. */
  initialFiltersKey: string;
};

export function TransactionsView({ orgId, canExport, initialPage, initialFiltersKey }: Props) {
  // The URL is the source of truth for filters and sort.
  const searchParams = useSearchParams();
  const filters = useMemo(() => parseFilters(searchParams), [searchParams]);
  const filtersKey = filtersToSearch(filters).toString();

  // Cursor stack for Prev/Next. It belongs to one set of filters: when the filters
  // change (including via back/forward), it no longer matches and counts as empty.
  const [pager, setPager] = useState<{ key: string; stack: string[] }>({ key: filtersKey, stack: [] });
  const stack = pager.key === filtersKey ? pager.stack : [];
  const cursor = stack.at(-1) ?? null;

  const queryClient = useQueryClient();
  const columns = useMemo(() => columnsFor(orgId), [orgId]);

  // Seed the cache once with the server-rendered first page. Unlike `initialData`, this
  // can't bring back an old snapshot after the cache entry has been garbage-collected.
  useState(() => {
    if (initialPage) {
      queryClient.setQueryData(["transactions", orgId, parseFilters(new URLSearchParams(initialFiltersKey)), null], initialPage);
    }
  });

  const query = useQuery({
    queryKey: ["transactions", orgId, filters, cursor],
    queryFn: ({ signal }) => getTransactions(orgId, filters, cursor, signal),
    placeholderData: keepPreviousData,
    // Rows only change when the user asks (filters, paging, or the "new transactions" banner).
    refetchOnReconnect: false,
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

  // "N new transactions": counted per set of filters, since changing filters loads fresh rows.
  const { subscribe } = useOrgEvents();
  const [fresh, setFresh] = useState({ key: filtersKey, count: 0 });
  const newCount = fresh.key === filtersKey ? fresh.count : 0;

  useEffect(
    () =>
      subscribe("transactions", (count) => {
        // Mark cached pages stale without refetching, so the visible rows never move.
        // The next page the user opens is fetched fresh.
        void queryClient.invalidateQueries({ queryKey: ["transactions", orgId], refetchType: "none" });
        setFresh((prev) => ({ key: filtersKey, count: (prev.key === filtersKey ? prev.count : 0) + count }));
      }),
    [subscribe, queryClient, orgId, filtersKey],
  );

  const showNewTransactions = () => {
    setFresh({ key: filtersKey, count: 0 });
    // Page 1 is already invalidated, so leaving page N refetches it; on page 1, refetch directly.
    if (stack.length === 0) void query.refetch();
    else setStack([]);
  };
  const page = query.data;
  const loadingNewPage = query.isFetching && query.isPlaceholderData;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <FilterBar filters={filters} onChange={onFilterChange} />
        {canExport && <ExportButton orgId={orgId} filters={filters} />}
      </div>

      <p aria-live="polite" className="sr-only">
        {loadingNewPage ? "Loading transactions…" : newCount > 0 ? `${newCount} new transactions available` : ""}
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
          {newCount > 0 && (
            <button
              type="button"
              onClick={showNewTransactions}
              className="self-center rounded-full bg-zinc-900 px-4 py-1.5 text-sm font-medium text-white shadow hover:bg-zinc-700 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-300"
            >
              {newCount === 1 ? "1 new transaction" : `${newCount} new transactions`} · Show
            </button>
          )}
          <DataTable
            caption="Transactions"
            columns={columns}
            rows={page.items}
            sort={{ key: filters.sort, dir: filters.dir }}
            onSortChange={onSortChange}
            getRowId={getRowId}
            busy={query.isFetching}
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

/** Queues a CSV export of exactly what the list shows (same filters and sort). */
function ExportButton({ orgId, filters }: { orgId: string; filters: Filters }) {
  const [state, setState] = useState<{ kind: "idle" } | { kind: "pending" } | { kind: "done" } | { kind: "error"; message: string }>({
    kind: "idle",
  });
  const start = async () => {
    setState({ kind: "pending" });
    const res = await bffPostJson(`/api/orgs/${encodeURIComponent(orgId)}/exports`, filters, exportJobResponseSchema);
    setState(res.ok ? { kind: "done" } : { kind: "error", message: exportErrorMessage(res) });
  };
  return (
    <div className="flex flex-col items-end gap-1">
      <button
        type="button"
        onClick={() => void start()}
        disabled={state.kind === "pending"}
        className="h-9 rounded-md border border-zinc-300 px-3 text-sm font-medium hover:bg-zinc-100 disabled:opacity-50 dark:border-zinc-700 dark:hover:bg-zinc-800"
      >
        {state.kind === "pending" ? "Starting export…" : "Export these filters"}
      </button>
      <p role="status" className="text-xs">
        {state.kind === "done" && (
          <>
            Export started.{" "}
            <Link href={`/orgs/${encodeURIComponent(orgId)}/reports`} className="font-medium underline">
              Follow it on Reports
            </Link>
          </>
        )}
        {state.kind === "error" && <span className="text-red-700 dark:text-red-300">{state.message}</span>}
      </p>
    </div>
  );
}
