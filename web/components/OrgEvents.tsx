"use client";

import { useQueryClient } from "@tanstack/react-query";
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import {
  balanceEventSchema,
  exportEventSchema,
  payoutEventSchema,
  transactionsEventSchema,
  type BalanceEvent,
  type ExportEvent,
  type PayoutEvent,
} from "@mini-payments/shared";

export type StreamStatus = "connecting" | "live" | "reconnecting";

type Handlers = {
  balance: (event: BalanceEvent) => void;
  transactions: (count: number) => void;
  payout: (event: PayoutEvent) => void;
  export: (event: ExportEvent) => void;
};
type EventType = keyof Handlers;

type OrgEventsValue = {
  status: StreamStatus;
  subscribe: <T extends EventType>(type: T, handler: Handlers[T]) => () => void;
};

const OrgEventsContext = createContext<OrgEventsValue | null>(null);

const MIN_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 30_000;

function backoff(attempt: number): number {
  const base = Math.min(MAX_BACKOFF_MS, MIN_BACKOFF_MS * 2 ** attempt);
  return base * (0.8 + Math.random() * 0.4); // ±20% jitter so tabs don't reconnect in lockstep
}

function parseJson(data: unknown): unknown {
  try {
    return typeof data === "string" ? JSON.parse(data) : null;
  } catch {
    return null;
  }
}

/**
 * Owns the single EventSource for an org and fans events out to subscribers.
 * One stream per page keeps us well under the API's per-org stream limit.
 */
export function OrgEventsProvider({ orgId, children }: { orgId: string; children: ReactNode }) {
  const queryClient = useQueryClient();
  const [listeners] = useState(() => ({
    balance: new Set<Handlers["balance"]>(),
    transactions: new Set<Handlers["transactions"]>(),
    payout: new Set<Handlers["payout"]>(),
    export: new Set<Handlers["export"]>(),
  }));

  // Status is tagged with its org, so a new org starts as "connecting" without an effect.
  const [conn, setConn] = useState<{ orgId: string; status: StreamStatus }>({ orgId, status: "connecting" });
  const status = conn.orgId === orgId ? conn.status : "connecting";

  useEffect(() => {
    let source: EventSource | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let attempt = 0;
    let recovering = false;

    const connect = () => {
      source = new EventSource(`/api/orgs/${encodeURIComponent(orgId)}/events`);

      source.onopen = () => {
        // Events can be missed before any open, the first one included: the page was
        // rendered on the server a moment earlier, and anything that happened in between
        // went to nobody. Resync whatever shows live state (cheap, and only active queries
        // refetch).
        void queryClient.invalidateQueries({ queryKey: ["balances", orgId] });
        void queryClient.invalidateQueries({ queryKey: ["payouts", orgId] });
        void queryClient.invalidateQueries({ queryKey: ["payout", orgId] });
        void queryClient.invalidateQueries({ queryKey: ["exports", orgId] });
        if (recovering) {
          // Transaction events may have been missed too. Mark the list stale without
          // refetching, so the visible rows stay put until the user asks for new data.
          void queryClient.invalidateQueries({ queryKey: ["transactions", orgId], refetchType: "none" });
        }
        attempt = 0;
        recovering = false;
        setConn({ orgId, status: "live" });
      };

      source.addEventListener("balance", (e) => {
        const parsed = balanceEventSchema.safeParse(parseJson(e.data));
        if (parsed.success) for (const fn of listeners.balance) fn(parsed.data);
      });

      source.addEventListener("transactions", (e) => {
        const parsed = transactionsEventSchema.safeParse(parseJson(e.data));
        if (parsed.success) for (const fn of listeners.transactions) fn(parsed.data.count);
      });

      source.addEventListener("payout", (e) => {
        const parsed = payoutEventSchema.safeParse(parseJson(e.data));
        if (parsed.success) for (const fn of listeners.payout) fn(parsed.data);
      });

      source.addEventListener("export", (e) => {
        const parsed = exportEventSchema.safeParse(parseJson(e.data));
        if (parsed.success) for (const fn of listeners.export) fn(parsed.data);
      });

      // EventSource would retry on its own at a fixed rate; close it and back off instead.
      source.onerror = () => {
        source?.close();
        source = null;
        recovering = true;
        setConn({ orgId, status: "reconnecting" });
        retryTimer = setTimeout(connect, backoff(attempt++));
      };
    };

    connect();
    // Runs on unmount, on org change, and when the route is hidden by <Activity>.
    return () => {
      clearTimeout(retryTimer);
      source?.close();
    };
  }, [orgId, queryClient, listeners]);

  const subscribe = useCallback(
    <T extends EventType>(type: T, handler: Handlers[T]) => {
      const set = listeners[type] as Set<Handlers[T]>;
      set.add(handler);
      return () => {
        set.delete(handler);
      };
    },
    [listeners],
  );

  const value = useMemo(() => ({ status, subscribe }), [status, subscribe]);
  return <OrgEventsContext.Provider value={value}>{children}</OrgEventsContext.Provider>;
}

export function useOrgEvents(): OrgEventsValue {
  const ctx = useContext(OrgEventsContext);
  if (!ctx) throw new Error("useOrgEvents must be used inside <OrgEventsProvider>");
  return ctx;
}
