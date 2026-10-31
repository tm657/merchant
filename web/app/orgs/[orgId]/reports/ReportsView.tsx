"use client";

import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";
import { useSearchParams } from "next/navigation";
import { useEffect, useId } from "react";
import { useAnnounce } from "@/components/LiveRegion";
import { useOrgEvents } from "@/components/OrgEvents";
import { EXPORT_STATUS_LABEL, exportErrorMessage } from "@/lib/admin-messages";
import { BffError, bffGet } from "@/lib/bff-client";
import { formatDateTime, formatMoney, TRANSACTION_TYPE_LABEL } from "@/lib/format";
import {
  exportJobListSchema,
  settlementsQuerySchema,
  settlementsResponseSchema,
  type ExportJob,
  type SettlementsResponse,
  type TransactionType,
} from "@mini-payments/shared";

type Range = { from: string; to: string };
type Props = {
  orgId: string;
  defaults: Range;
  lastSettledDay: string;
  initialExports: { items: ExportJob[] } | null;
  initialSettlements: SettlementsResponse | null;
};

export function ReportsView(props: Props) {
  return (
    <div className="flex flex-col gap-10">
      <Exports orgId={props.orgId} initial={props.initialExports} />
      <Settlements {...props} />
    </div>
  );
}

/** "Pay-outs · USD · from 2026-10-01 · newest first" */
function describeFilters(f: Record<string, unknown>): string {
  const parts: string[] = [];
  if (typeof f.type === "string") parts.push(`${TRANSACTION_TYPE_LABEL[f.type as TransactionType] ?? f.type}s`);
  if (typeof f.status === "string") parts.push(f.status);
  if (typeof f.currency === "string") parts.push(f.currency);
  if (typeof f.from === "string") parts.push(`from ${f.from}`);
  if (typeof f.to === "string") parts.push(`to ${f.to}`);
  if (typeof f.q === "string") parts.push(`“${f.q}”`);
  parts.push(f.sort === "amount" ? `by amount ${f.dir === "asc" ? "ascending" : "descending"}` : f.dir === "asc" ? "oldest first" : "newest first");
  return parts.length === 1 ? `All transactions, ${parts[0]}` : parts.join(" · ");
}

const number = (n: number) => n.toLocaleString("en-US");

function Exports({ orgId, initial }: { orgId: string; initial: { items: ExportJob[] } | null }) {
  const queryClient = useQueryClient();
  const announce = useAnnounce();
  const key = ["exports", orgId] as const;
  const query = useQuery({
    queryKey: key,
    queryFn: ({ signal }) => bffGet(`/api/orgs/${encodeURIComponent(orgId)}/exports`, exportJobListSchema, signal),
    initialData: initial ?? undefined,
  });

  // Progress arrives over SSE: update the row in place; final states refetch the list.
  const { subscribe } = useOrgEvents();
  useEffect(
    () =>
      subscribe("export", (e) => {
        queryClient.setQueryData<{ items: ExportJob[] }>(["exports", orgId], (old) =>
          old
            ? { items: old.items.map((j) => (j.id === e.exportId ? { ...j, status: e.status, rowsWritten: e.rowsWritten, rowsTotal: e.rowsTotal } : j)) }
            : old,
        );
        if (e.status !== "running") {
          void queryClient.invalidateQueries({ queryKey: ["exports", orgId] });
          if (e.status === "completed") announce(`Export ready: ${number(e.rowsWritten)} rows.`);
          if (e.status === "failed") announce("An export failed.");
        }
      }),
    [subscribe, queryClient, orgId, announce],
  );

  const items = query.data?.items;
  return (
    <section aria-labelledby="exports-heading" className="flex flex-col gap-3">
      <div>
        <h2 id="exports-heading" className="text-lg font-semibold">
          Exports
        </h2>
        <p className="text-sm text-zinc-600 dark:text-zinc-400">
          Start one with “Export these filters” on the Transactions page. Files can be downloaded for 24 hours.
        </p>
      </div>
      {query.isError ? (
        <p role="alert" className="text-sm text-red-700 dark:text-red-300">
          {query.error instanceof BffError ? exportErrorMessage(query.error) : "Could not load exports."}
        </p>
      ) : !items ? (
        <div className="h-20 animate-pulse rounded-lg bg-zinc-100 dark:bg-zinc-900" role="status" aria-label="Loading exports" />
      ) : items.length === 0 ? (
        <p className="text-sm text-zinc-500">No exports yet.</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {items.map((j) => (
            <ExportRow key={j.id} orgId={orgId} job={j} />
          ))}
        </ul>
      )}
    </section>
  );
}

function ExportRow({ orgId, job: j }: { orgId: string; job: ExportJob }) {
  const labelId = useId();
  const total = j.rowsTotal ?? 0;
  return (
    <li className="flex flex-col gap-2 rounded-lg border border-zinc-200 p-3 dark:border-zinc-800">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <p id={labelId} className="text-sm font-medium">
            {describeFilters(j.filters)}
          </p>
          <p className="text-xs text-zinc-500">
            {j.requestedBy.name} · {formatDateTime(j.createdAt)} · {EXPORT_STATUS_LABEL[j.status]}
            {j.status === "completed" && j.expiresAt && ` · available until ${formatDateTime(j.expiresAt)}`}
          </p>
        </div>
        {j.downloadable && (
          // A plain link: the BFF and API authorise this request like any other.
          <a
            href={`/api/orgs/${encodeURIComponent(orgId)}/exports/${encodeURIComponent(j.id)}/download`}
            className="rounded-md bg-zinc-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-zinc-700 dark:bg-zinc-100 dark:text-zinc-900"
          >
            Download CSV<span className="sr-only"> for {describeFilters(j.filters)}</span>
          </a>
        )}
      </div>
      {(j.status === "running" || j.status === "queued") && (
        <div className="flex items-center gap-3">
          <progress
            aria-labelledby={labelId}
            // Indeterminate while queued or counting; then rows written of rows total.
            value={j.status === "running" && total > 0 ? j.rowsWritten : undefined}
            max={total > 0 ? total : undefined}
            className="h-2 w-full max-w-md accent-zinc-900 dark:accent-zinc-100"
          />
          <span className="whitespace-nowrap text-xs tabular-nums text-zinc-500">
            {j.status === "queued" ? "Waiting for a slot…" : total > 0 ? `${number(j.rowsWritten)} of ${number(total)} rows` : "Counting rows…"}
          </span>
        </div>
      )}
      {j.status === "completed" && (
        <p className="text-xs text-zinc-500">
          {number(j.rowsWritten)} rows · {(j.bytesWritten / 1024).toFixed(1)} KB
        </p>
      )}
      {j.status === "failed" && j.error && (
        <p className="text-sm text-red-700 dark:text-red-300">{j.error}</p>
      )}
    </li>
  );
}

function Settlements({ orgId, defaults, lastSettledDay, initialSettlements }: Props) {
  const searchParams = useSearchParams();
  const asked = settlementsQuerySchema.safeParse({ from: searchParams.get("from") ?? undefined, to: searchParams.get("to") ?? undefined });
  const range = asked.success ? asked.data : defaults;
  const ids = { from: useId(), to: useId() };

  const query = useQuery({
    queryKey: ["settlements", orgId, range.from, range.to],
    queryFn: ({ signal }) =>
      bffGet(`/api/orgs/${encodeURIComponent(orgId)}/settlements?${new URLSearchParams(range)}`, settlementsResponseSchema, signal),
    initialData: initialSettlements && initialSettlements.from === range.from && initialSettlements.to === range.to ? initialSettlements : undefined,
    placeholderData: keepPreviousData,
  });

  // The range lives in the URL, so a settlement view can be shared and survives reload.
  const setRange = (patch: Partial<Range>) => {
    const next = { ...range, ...patch };
    if (next.from > next.to) return;
    const p = new URLSearchParams(window.location.search);
    p.set("from", next.from);
    p.set("to", next.to);
    window.history.pushState(null, "", `?${p}`);
  };

  const data = query.data;
  const field = "rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-900";
  return (
    <section aria-labelledby="settlements-heading" className="flex flex-col gap-3">
      <div>
        <h2 id="settlements-heading" className="text-lg font-semibold">
          Settlements
        </h2>
        <p className="text-sm text-zinc-600 dark:text-zinc-400">
          Successful transactions per UTC day. Settled through {lastSettledDay}; today settles after midnight UTC.
        </p>
      </div>
      <div className="flex flex-wrap items-end gap-3">
        <label htmlFor={ids.from} className="flex flex-col gap-1 text-sm font-medium">
          From
          <input id={ids.from} type="date" value={range.from} max={range.to} onChange={(e) => e.target.value && setRange({ from: e.target.value })} className={field} />
        </label>
        <label htmlFor={ids.to} className="flex flex-col gap-1 text-sm font-medium">
          To
          <input id={ids.to} type="date" value={range.to} min={range.from} max={lastSettledDay} onChange={(e) => e.target.value && setRange({ to: e.target.value })} className={field} />
        </label>
      </div>

      {query.isError ? (
        <p role="alert" className="text-sm text-red-700 dark:text-red-300">
          Could not load settlements.
        </p>
      ) : !data ? (
        <div className="h-40 animate-pulse rounded-lg bg-zinc-100 dark:bg-zinc-900" role="status" aria-label="Loading settlements" />
      ) : (
        <div className="overflow-x-auto rounded-lg border border-zinc-200 dark:border-zinc-800">
          <table aria-busy={query.isFetching} className="w-full border-collapse text-sm">
            <caption className="sr-only">
              Settlements from {data.from} to {data.to}, with totals per currency
            </caption>
            <thead className="bg-zinc-50 dark:bg-zinc-900">
              <tr>
                {["Date", "Currency", "Pay-ins", "Pay-in amount", "Pay-outs", "Pay-out amount", "Net"].map((h, i) => (
                  <th key={h} scope="col" className={`px-4 py-2 font-medium ${i >= 2 ? "text-right" : "text-left"}`}>
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data.items.length === 0 ? (
                <tr>
                  <td colSpan={7} className="px-4 py-8 text-center text-zinc-500">
                    No settled transactions in this range.
                  </td>
                </tr>
              ) : (
                data.items.map((s) => (
                  <tr key={`${s.date}-${s.currency}`} className="border-t border-zinc-200 dark:border-zinc-800">
                    <td className="px-4 py-2">{s.date}</td>
                    <td className="px-4 py-2">{s.currency}</td>
                    <td className="px-4 py-2 text-right tabular-nums">{number(s.payinCount)}</td>
                    <td className="px-4 py-2 text-right tabular-nums">{formatMoney(s.payinAmount, s.currency)}</td>
                    <td className="px-4 py-2 text-right tabular-nums">{number(s.payoutCount)}</td>
                    <td className="px-4 py-2 text-right tabular-nums">{formatMoney(s.payoutAmount, s.currency)}</td>
                    <td className="px-4 py-2 text-right font-medium tabular-nums">{formatMoney(s.netAmount, s.currency)}</td>
                  </tr>
                ))
              )}
            </tbody>
            {data.totals.length > 0 && (
              <tfoot className="border-t-2 border-zinc-300 bg-zinc-50 font-semibold dark:border-zinc-700 dark:bg-zinc-900">
                {data.totals.map((t) => (
                  <tr key={t.currency}>
                    <th scope="row" className="px-4 py-2 text-left">
                      Total
                    </th>
                    <td className="px-4 py-2">{t.currency}</td>
                    <td className="px-4 py-2 text-right tabular-nums">{number(t.payinCount)}</td>
                    <td className="px-4 py-2 text-right tabular-nums">{formatMoney(t.payinAmount, t.currency)}</td>
                    <td className="px-4 py-2 text-right tabular-nums">{number(t.payoutCount)}</td>
                    <td className="px-4 py-2 text-right tabular-nums">{formatMoney(t.payoutAmount, t.currency)}</td>
                    <td className="px-4 py-2 text-right tabular-nums">{formatMoney(t.netAmount, t.currency)}</td>
                  </tr>
                ))}
              </tfoot>
            )}
          </table>
        </div>
      )}
    </section>
  );
}
