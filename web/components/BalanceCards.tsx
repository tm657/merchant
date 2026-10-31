"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { useOrgEvents, type StreamStatus } from "@/components/OrgEvents";
import { formatMoney } from "@/lib/format";
import { bffGet } from "@/lib/bff-client";
import { balancesSchema, type Balances } from "@mini-payments/shared";

const POLL_MS = 20_000;

const balancesKey = (orgId: string) => ["balances", orgId] as const;

function getBalances(orgId: string, signal: AbortSignal): Promise<Balances> {
  return bffGet(`/api/orgs/${encodeURIComponent(orgId)}/balances`, balancesSchema, signal);
}

const STATUS_LABEL: Record<StreamStatus, { text: string; dot: string }> = {
  live: { text: "Live", dot: "bg-emerald-500" },
  connecting: { text: "Connecting…", dot: "bg-zinc-400" },
  reconnecting: { text: "Reconnecting · refreshing every 20s", dot: "bg-amber-500" },
};

type Props = { orgId: string; initialBalances: Balances | null };

export function BalanceCards({ orgId, initialBalances }: Props) {
  const queryClient = useQueryClient();
  const { status, subscribe } = useOrgEvents();

  // Seed the cache once with the server-rendered balances (not on every render).
  useState(() => {
    if (initialBalances) queryClient.setQueryData(balancesKey(orgId), initialBalances);
  });

  const query = useQuery({
    queryKey: balancesKey(orgId),
    queryFn: ({ signal }) => getBalances(orgId, signal),
    // Poll only while the live stream is down.
    refetchInterval: status === "live" ? false : POLL_MS,
  });

  useEffect(
    () =>
      subscribe("balance", (event) => {
        let known = false;
        queryClient.setQueryData<Balances>(balancesKey(orgId), (old) => {
          if (!old) return old;
          known = old.balances.some((b) => b.currency === event.currency);
          if (!known) return old;
          return {
            balances: old.balances.map((b) =>
              b.currency === event.currency ? { ...b, available: event.available, reserved: event.reserved } : b,
            ),
          };
        });
        // A currency we haven't seen yet: refetch rather than guess where it goes.
        if (!known) void queryClient.invalidateQueries({ queryKey: balancesKey(orgId) });
      }),
    [subscribe, queryClient, orgId],
  );

  const indicator = STATUS_LABEL[status];

  return (
    <section aria-labelledby="balances-heading" className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <h2 id="balances-heading" className="text-sm font-semibold uppercase tracking-wide text-zinc-500">
          Available balances
        </h2>
        <span role="status" className="flex items-center gap-2 text-xs text-zinc-500">
          <span aria-hidden="true" className={`h-2 w-2 rounded-full ${indicator.dot}`} />
          {indicator.text}
        </span>
      </div>

      {query.isError && !query.data ? (
        <div role="alert" className="flex items-center gap-3 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-200">
          Could not load balances.
          <button type="button" onClick={() => void query.refetch()} className="font-medium underline">
            Retry
          </button>
        </div>
      ) : !query.data ? (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3" aria-label="Loading balances">
          {[0, 1, 2].map((i) => (
            <div key={i} className="h-20 animate-pulse rounded-lg bg-zinc-100 dark:bg-zinc-900" />
          ))}
        </div>
      ) : query.data.balances.length === 0 ? (
        <p className="text-sm text-zinc-500">No balances yet.</p>
      ) : (
        <ul className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          {query.data.balances.map((b) => (
            <li key={b.currency} className="rounded-lg border border-zinc-200 p-4 dark:border-zinc-800">
              <p className="text-xs font-medium text-zinc-500">{b.currency}</p>
              <p className="mt-1 text-xl font-semibold tabular-nums">{formatMoney(b.available, b.currency)}</p>
              {/* Only roles with balances:read ever render this component. */}
              <p className="mt-1 text-xs tabular-nums text-zinc-500">
                Reserved for pay-outs: {formatMoney(b.reserved, b.currency)}
              </p>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
