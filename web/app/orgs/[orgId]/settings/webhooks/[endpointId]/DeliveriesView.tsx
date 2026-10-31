"use client";

import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useSearchParams } from "next/navigation";
import { useId, useState } from "react";
import { DataTable, type Column } from "@/components/DataTable";
import { useAnnounce } from "@/components/LiveRegion";
import { TableSkeleton } from "@/components/TableSkeleton";
import { adminErrorMessage, DELIVERY_STATUS_LABEL, DELIVERY_STATUS_STYLE } from "@/lib/admin-messages";
import { BffError, bffGet, bffSend } from "@/lib/bff-client";
import { formatDateTime } from "@/lib/format";
import {
  WEBHOOK_DELIVERY_STATUSES,
  WEBHOOK_MAX_ATTEMPTS,
  webhookDeliveriesPageSchema,
  webhookDeliveryResponseSchema,
  type WebhookDelivery,
  type WebhookDeliveryStatus,
} from "@mini-payments/shared";
import { z } from "zod";

type Props = { orgId: string; endpointId: string; enabled: boolean };

export function DeliveriesView({ orgId, endpointId, enabled }: Props) {
  const searchParams = useSearchParams();
  // The status filter lives in the URL.
  const status = z.enum(WEBHOOK_DELIVERY_STATUSES).optional().catch(undefined).parse(searchParams.get("status") ?? undefined);
  const statusKey = status ?? "all";
  const [pager, setPager] = useState<{ key: string; stack: string[] }>({ key: statusKey, stack: [] });
  const stack = pager.key === statusKey ? pager.stack : [];
  const cursor = stack.at(-1) ?? null;
  const setStack = (next: string[]) => setPager({ key: statusKey, stack: next });
  const queryClient = useQueryClient();
  const announce = useAnnounce();
  const selectId = useId();
  const base = `/api/orgs/${encodeURIComponent(orgId)}/webhooks/${encodeURIComponent(endpointId)}`;

  const query = useQuery({
    queryKey: ["webhook-deliveries", orgId, endpointId, statusKey, cursor],
    queryFn: ({ signal }) => {
      const qs = new URLSearchParams();
      if (status) qs.set("status", status);
      if (cursor) qs.set("cursor", cursor);
      const q = qs.toString();
      return bffGet(`${base}/deliveries${q ? `?${q}` : ""}`, webhookDeliveriesPageSchema, signal);
    },
    placeholderData: keepPreviousData,
    // Deliveries change in the background worker; poll while any is still in flight.
    refetchInterval: (q) => (q.state.data?.items.some((d) => d.status === "pending" || d.status === "delivering") ? 3000 : false),
  });

  const [error, setError] = useState<string | null>(null);
  const redeliver = useMutation({
    mutationFn: (d: WebhookDelivery) => bffSend("POST", `${base}/deliveries/${d.id}/redeliver`, undefined, webhookDeliveryResponseSchema),
    onSuccess: (res) => {
      void queryClient.invalidateQueries({ queryKey: ["webhook-deliveries", orgId, endpointId] });
      if (res.ok) {
        setError(null);
        announce("Redelivery queued.");
      } else setError(adminErrorMessage(res));
    },
  });

  const setStatus = (next: WebhookDeliveryStatus | undefined) => {
    const p = new URLSearchParams(window.location.search);
    if (next) p.set("status", next);
    else p.delete("status");
    const qs = p.toString();
    window.history.pushState(null, "", qs ? `?${qs}` : window.location.pathname);
  };

  const columns: Column<WebhookDelivery, never>[] = [
    { id: "created", header: "Created", cell: (d) => formatDateTime(d.createdAt) },
    {
      id: "event",
      header: "Event",
      cell: (d) => (
        <span>
          <span className="font-mono">{d.eventType}</span>
          <span className="block font-mono text-xs text-zinc-500">{d.eventId}</span>
          {d.redeliveryOf && <span className="block text-xs text-zinc-500">Redelivery</span>}
        </span>
      ),
    },
    {
      id: "status",
      header: "Status",
      cell: (d) => (
        <span className={`whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium ${DELIVERY_STATUS_STYLE[d.status]}`}>
          {DELIVERY_STATUS_LABEL[d.status]}
        </span>
      ),
    },
    {
      id: "attempts",
      header: "Attempts",
      cell: (d) => (
        <span className="text-sm">
          {d.attempts} / {WEBHOOK_MAX_ATTEMPTS}
          {d.status === "pending" && d.nextAttemptAt && d.attempts > 0 && (
            <span className="block text-xs text-zinc-500">next {formatDateTime(d.nextAttemptAt)}</span>
          )}
        </span>
      ),
    },
    {
      id: "result",
      header: "Last result",
      cell: (d) => (
        <span className="text-xs">
          {d.lastResponseCode !== null && <span className="font-mono">HTTP {d.lastResponseCode}</span>}
          {d.lastError && <span className="block break-words text-red-700 dark:text-red-300">{d.lastError}</span>}
          {d.lastResponseCode === null && !d.lastError && "—"}
        </span>
      ),
    },
    {
      id: "actions",
      header: "Actions",
      cell: (d) =>
        d.status === "succeeded" || d.status === "dead" ? (
          <button
            type="button"
            onClick={() => redeliver.mutate(d)}
            disabled={!enabled || redeliver.isPending}
            title={enabled ? undefined : "Enable the endpoint to redeliver"}
            className="rounded-md border border-zinc-300 px-2 py-1 text-xs font-medium hover:bg-zinc-100 disabled:opacity-40 dark:border-zinc-700 dark:hover:bg-zinc-800"
          >
            Redeliver<span className="sr-only"> {d.eventType} {d.eventId}</span>
          </button>
        ) : null,
    },
  ];

  const page = query.data;
  return (
    <div className="flex flex-col gap-4">
      <label htmlFor={selectId} className="flex w-fit flex-col gap-1 text-sm font-medium">
        Status
        <select
          id={selectId}
          value={status ?? ""}
          onChange={(e) => setStatus((e.target.value || undefined) as WebhookDeliveryStatus | undefined)}
          className="rounded-md border border-zinc-300 bg-white px-3 py-1.5 dark:border-zinc-700 dark:bg-zinc-900"
        >
          <option value="">All</option>
          {WEBHOOK_DELIVERY_STATUSES.map((s) => (
            <option key={s} value={s}>
              {DELIVERY_STATUS_LABEL[s]}
            </option>
          ))}
        </select>
      </label>
      {!enabled && <p className="text-sm text-amber-800 dark:text-amber-300">This endpoint is disabled: new events aren&apos;t sent to it.</p>}
      {error && (
        <p role="alert" className="text-sm text-red-700 dark:text-red-300">
          {error}
        </p>
      )}
      {query.isError ? (
        <p role="alert" className="text-sm text-red-700 dark:text-red-300">
          {query.error instanceof BffError ? adminErrorMessage(query.error) : "Could not load deliveries."}
        </p>
      ) : !page ? (
        <TableSkeleton label="Loading deliveries" />
      ) : (
        <>
          <DataTable
            caption="Webhook deliveries, newest first"
            columns={columns}
            rows={page.items}
            sort={{ key: "" as never, dir: "desc" }}
            onSortChange={() => {}}
            getRowId={(d) => d.id}
            busy={query.isFetching}
            renderEmpty={() => <p className="text-zinc-500">No deliveries yet.</p>}
          />
          <nav aria-label="Pagination" className="flex items-center justify-between text-sm">
            <span className="text-zinc-500">Page {stack.length + 1}</span>
            <div className="flex gap-2">
              <button type="button" onClick={() => setStack(stack.slice(0, -1))} disabled={stack.length === 0} className="rounded-md border border-zinc-300 px-3 py-1.5 font-medium disabled:opacity-40 dark:border-zinc-700">
                Newer
              </button>
              <button type="button" onClick={() => page.nextCursor && setStack([...stack, page.nextCursor])} disabled={!page.nextCursor} className="rounded-md border border-zinc-300 px-3 py-1.5 font-medium disabled:opacity-40 dark:border-zinc-700">
                Older
              </button>
            </div>
          </nav>
        </>
      )}
    </div>
  );
}
