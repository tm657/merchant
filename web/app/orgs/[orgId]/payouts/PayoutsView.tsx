"use client";

import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";
import { useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { DataTable, type Column } from "@/components/DataTable";
import { useAnnounce } from "@/components/LiveRegion";
import { useOrgEvents } from "@/components/OrgEvents";
import { PayoutStatusBadge } from "@/components/PayoutStatusBadge";
import { TableSkeleton } from "@/components/TableSkeleton";
import { BffError, bffGet } from "@/lib/bff-client";
import { formatDateTime, formatMoney } from "@/lib/format";
import { parsePayoutFilters, payoutFiltersToSearch, type PayoutFilters } from "@/lib/payout-filters";
import { PAYOUT_STATUS_LABEL, payoutErrorMessage } from "@/lib/payout-messages";
import {
  can,
  PAYOUT_STATUSES,
  payoutsPageSchema,
  type Payout,
  type PayoutsPage,
  type PayoutStatus,
  type Role,
} from "@mini-payments/shared";
import { CreatePayoutDialog } from "./CreatePayoutDialog";
import { PayoutDetailPanel } from "./PayoutDetailPanel";

const payoutsKey = (orgId: string, status: PayoutStatus | undefined, cursor: string | null) =>
  ["payouts", orgId, status ?? "all", cursor] as const;

function getPayouts(orgId: string, status: PayoutStatus | undefined, cursor: string | null, signal: AbortSignal) {
  const qs = new URLSearchParams();
  if (status) qs.set("status", status);
  if (cursor) qs.set("cursor", cursor);
  const q = qs.toString();
  return bffGet(`/api/orgs/${encodeURIComponent(orgId)}/payouts${q ? `?${q}` : ""}`, payoutsPageSchema, signal);
}

type Props = {
  orgId: string;
  role: Role;
  currentUserId: string;
  /** First page rendered on the server for `initialStatus`, or null if that fetch failed. */
  initialPage: PayoutsPage | null;
  initialStatus: PayoutStatus | null;
};

export function PayoutsView({ orgId, role, currentUserId, initialPage, initialStatus }: Props) {
  // The URL is the source of truth: ?status= filters the list, ?payout= opens the detail panel.
  const searchParams = useSearchParams();
  const filters = useMemo(() => parsePayoutFilters(searchParams), [searchParams]);
  const statusKey = filters.status ?? "all";

  // Cursor stack for Prev/Next, tied to one status filter (a new filter starts at page 1).
  const [pager, setPager] = useState<{ key: string; stack: string[] }>({ key: statusKey, stack: [] });
  const stack = pager.key === statusKey ? pager.stack : [];
  const cursor = stack.at(-1) ?? null;
  const setStack = (next: string[]) => setPager({ key: statusKey, stack: next });

  const queryClient = useQueryClient();
  const announce = useAnnounce();

  useState(() => {
    if (initialPage) queryClient.setQueryData(payoutsKey(orgId, initialStatus ?? undefined, null), initialPage);
  });

  const query = useQuery({
    queryKey: payoutsKey(orgId, filters.status, cursor),
    queryFn: ({ signal }) => getPayouts(orgId, filters.status, cursor, signal),
    placeholderData: keepPreviousData,
  });

  const updateUrl = useCallback((patch: Partial<PayoutFilters>, opts?: { replace?: boolean }) => {
    const current = parsePayoutFilters(new URLSearchParams(window.location.search));
    const qs = payoutFiltersToSearch({ ...current, ...patch }).toString();
    const url = qs ? `?${qs}` : window.location.pathname;
    if (opts?.replace) window.history.replaceState(null, "", url);
    else window.history.pushState(null, "", url);
  }, []);

  // Live: any pay-out change refetches the visible page; the panel refetches itself.
  // Only the open pay-out is announced, so a busy org doesn't flood screen readers.
  const { subscribe } = useOrgEvents();
  const selectedRef = useRef(filters.payout);
  useEffect(() => {
    selectedRef.current = filters.payout;
  }, [filters.payout]);
  useEffect(
    () =>
      subscribe("payout", (event) => {
        void queryClient.invalidateQueries({ queryKey: ["payouts", orgId] });
        void queryClient.invalidateQueries({ queryKey: ["payout", orgId, event.payoutId] });
        if (event.payoutId === selectedRef.current) {
          announce(`The open pay-out is now ${PAYOUT_STATUS_LABEL[event.status].toLowerCase()}.`);
        }
      }),
    [subscribe, queryClient, orgId, announce],
  );

  const [creating, setCreating] = useState(false);
  const canCreate = can(role, "payout:create");

  const onCreated = (payout: Payout, replayed: boolean) => {
    setCreating(false);
    void queryClient.invalidateQueries({ queryKey: ["payouts", orgId] });
    // Show the new pay-out: clear the filter (it's pending approval) and open it.
    updateUrl({ status: undefined, payout: payout.id });
    announce(
      replayed
        ? "This pay-out had already been created. Showing it now."
        : `Pay-out of ${formatMoney(payout.amount, payout.currency)} to ${payout.beneficiaryName} created. It is waiting for approval.`,
    );
  };

  const columns: Column<Payout, never>[] = [
    { id: "created", header: "Created", cell: (p) => formatDateTime(p.createdAt) },
    {
      id: "beneficiary",
      header: "Beneficiary",
      cell: (p) => (
        <button
          type="button"
          onClick={() => updateUrl({ payout: p.id })}
          aria-current={p.id === filters.payout ? "true" : undefined}
          className="text-left font-medium underline-offset-2 hover:underline focus-visible:outline-2"
        >
          {p.beneficiaryName}
          <span className="block text-xs font-normal text-zinc-500">•••• {p.accountLast4}</span>
        </button>
      ),
    },
    { id: "by", header: "Requested by", cell: (p) => (p.createdBy.id === currentUserId ? "You" : p.createdBy.name) },
    { id: "status", header: "Status", cell: (p) => <PayoutStatusBadge status={p.status} /> },
    { id: "amount", header: "Amount", align: "right", cell: (p) => formatMoney(p.amount, p.currency) },
  ];

  const page = query.data;
  const loadingNewPage = query.isFetching && query.isPlaceholderData;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium">Status</span>
          <select
            value={filters.status ?? ""}
            onChange={(e) => updateUrl({ status: (e.target.value || undefined) as PayoutStatus | undefined })}
            className="rounded-md border border-zinc-300 bg-white px-3 py-1.5 dark:border-zinc-700 dark:bg-zinc-900"
          >
            <option value="">All statuses</option>
            {PAYOUT_STATUSES.map((s) => (
              <option key={s} value={s}>
                {PAYOUT_STATUS_LABEL[s]}
              </option>
            ))}
          </select>
        </label>
        {canCreate && (
          <button
            type="button"
            onClick={() => setCreating(true)}
            className="rounded-md bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-700 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-300"
          >
            New pay-out
          </button>
        )}
      </div>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_22rem]">
        <div className="flex min-w-0 flex-col gap-3">
          {query.isError ? (
            <div role="alert" className="flex flex-col items-start gap-3 rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-200">
              <p>
                {query.error instanceof BffError
                  ? query.error.code === "invalid_cursor"
                    ? "This page link is no longer valid."
                    : payoutErrorMessage(query.error)
                  : "Something went wrong while loading pay-outs."}
              </p>
              <div className="flex gap-2">
                <button type="button" onClick={() => void query.refetch()} className="rounded-md bg-red-700 px-3 py-1.5 font-medium text-white hover:bg-red-800">
                  Retry
                </button>
                {stack.length > 0 && (
                  <button type="button" onClick={() => setStack([])} className="rounded-md px-3 py-1.5 font-medium hover:bg-red-100 dark:hover:bg-red-900">
                    Back to first page
                  </button>
                )}
              </div>
            </div>
          ) : !page ? (
            <TableSkeleton label="Loading pay-outs" />
          ) : (
            <>
              <DataTable
                caption="Pay-outs"
                columns={columns}
                rows={page.items}
                sort={{ key: "" as never, dir: "desc" }}
                onSortChange={() => {}}
                getRowId={(p) => p.id}
                busy={query.isFetching}
                renderEmpty={() => (
                  <div className="flex flex-col items-center gap-1 text-zinc-500">
                    <p className="font-medium text-zinc-700 dark:text-zinc-300">No pay-outs found</p>
                    <p>{filters.status ? "Try another status." : canCreate ? "Create one with “New pay-out”." : ""}</p>
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

        {filters.payout && (
          <PayoutDetailPanel
            key={filters.payout}
            orgId={orgId}
            payoutId={filters.payout}
            role={role}
            currentUserId={currentUserId}
            onClose={() => updateUrl({ payout: undefined })}
          />
        )}
      </div>

      {canCreate && (
        <CreatePayoutDialog orgId={orgId} open={creating} onClose={() => setCreating(false)} onCreated={onCreated} />
      )}
    </div>
  );
}
