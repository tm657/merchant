"use client";

import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";
import { useSearchParams } from "next/navigation";
import { useCallback, useId, useMemo, useState } from "react";
import { DataTable, type Column } from "@/components/DataTable";
import { useAnnounce } from "@/components/LiveRegion";
import { TableSkeleton } from "@/components/TableSkeleton";
import { AUDIT_ACTION_LABEL, adminErrorMessage } from "@/lib/admin-messages";
import { auditFiltersToSearch, parseAuditFilters } from "@/lib/audit-filters";
import { BffError, bffGet } from "@/lib/bff-client";
import { formatDateTime } from "@/lib/format";
import {
  AUDIT_ACTIONS,
  AUDIT_EXPORT_MAX_ROWS,
  auditPageSchema,
  SYSTEM_ACTOR,
  type AuditAction,
  type AuditEntry,
  type AuditFilters,
  type AuditPage,
  type OrgMembers,
} from "@mini-payments/shared";

type Props = {
  orgId: string;
  canExport: boolean;
  members: OrgMembers["items"];
  initialPage: AuditPage | null;
  initialFiltersKey: string;
};

const auditKey = (orgId: string, filtersKey: string, cursor: string | null) => ["audit", orgId, filtersKey, cursor] as const;

function getAudit(orgId: string, filters: AuditFilters, cursor: string | null, signal: AbortSignal) {
  const qs = auditFiltersToSearch(filters);
  if (cursor) qs.set("cursor", cursor);
  const q = qs.toString();
  return bffGet(`/api/orgs/${encodeURIComponent(orgId)}/audit${q ? `?${q}` : ""}`, auditPageSchema, signal);
}

/** Metadata as short "key: value" lines. Values are already free of secrets (the API never stores them). */
function Details({ entry }: { entry: AuditEntry }) {
  const pairs = Object.entries(entry.metadata);
  return (
    <details className="text-xs">
      <summary className="cursor-pointer text-zinc-600 dark:text-zinc-400">Details</summary>
      <dl className="mt-1 grid grid-cols-[auto_1fr] gap-x-2 gap-y-0.5">
        {entry.targetType && (
          <>
            <dt className="text-zinc-500">Target</dt>
            <dd className="break-all font-mono">
              {entry.targetType} {entry.targetId}
            </dd>
          </>
        )}
        {pairs.map(([k, v]) => (
          <span key={k} className="contents">
            <dt className="text-zinc-500">{k}</dt>
            <dd className="break-all font-mono">{typeof v === "string" ? v : JSON.stringify(v)}</dd>
          </span>
        ))}
        {entry.userAgent && (
          <>
            <dt className="text-zinc-500">User agent</dt>
            <dd className="break-all">{entry.userAgent}</dd>
          </>
        )}
        {entry.requestId && (
          <>
            <dt className="text-zinc-500">Request</dt>
            <dd className="break-all font-mono">{entry.requestId}</dd>
          </>
        )}
      </dl>
    </details>
  );
}

export function AuditView({ orgId, canExport, members, initialPage, initialFiltersKey }: Props) {
  const searchParams = useSearchParams();
  const filters = useMemo(() => parseAuditFilters(searchParams), [searchParams]);
  const filtersKey = auditFiltersToSearch(filters).toString();
  const queryClient = useQueryClient();
  const announce = useAnnounce();
  const ids = { actor: useId(), action: useId(), from: useId(), to: useId() };

  const [pager, setPager] = useState<{ key: string; stack: string[] }>({ key: filtersKey, stack: [] });
  const stack = pager.key === filtersKey ? pager.stack : [];
  const cursor = stack.at(-1) ?? null;
  const setStack = (next: string[]) => setPager({ key: filtersKey, stack: next });

  useState(() => {
    if (initialPage) queryClient.setQueryData(auditKey(orgId, initialFiltersKey, null), initialPage);
  });

  const query = useQuery({
    queryKey: auditKey(orgId, filtersKey, cursor),
    queryFn: ({ signal }) => getAudit(orgId, filters, cursor, signal),
    placeholderData: keepPreviousData,
  });

  const updateUrl = useCallback((patch: Partial<AuditFilters>) => {
    const current = parseAuditFilters(new URLSearchParams(window.location.search));
    const next = { ...current, ...patch };
    const qs = auditFiltersToSearch(next).toString();
    window.history.pushState(null, "", qs ? `?${qs}` : window.location.pathname);
  }, []);

  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);

  // POST (it's an audited action), then hand the CSV to the browser as a download.
  async function exportCsv() {
    setExporting(true);
    setExportError(null);
    try {
      const res = await fetch(`/api/orgs/${encodeURIComponent(orgId)}/audit/export`, {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(filters),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        setExportError(adminErrorMessage({ status: res.status, code: body?.error ?? "unknown_error" }));
        return;
      }
      const blob = await res.blob();
      const name = /filename="([^"]+)"/.exec(res.headers.get("content-disposition") ?? "")?.[1] ?? "audit.csv";
      const link = document.createElement("a");
      link.href = URL.createObjectURL(blob);
      link.download = name;
      link.click();
      URL.revokeObjectURL(link.href);
      const rows = Number(res.headers.get("x-export-rows") ?? 0);
      const truncated = res.headers.get("x-export-truncated") === "true";
      announce(
        truncated
          ? `Exported the newest ${rows} entries. Narrow the filters to export the rest.`
          : `Exported ${rows} entr${rows === 1 ? "y" : "ies"}.`,
      );
      // The export itself is now in the log.
      void queryClient.invalidateQueries({ queryKey: ["audit", orgId] });
    } catch {
      setExportError(adminErrorMessage({ status: 0, code: "network" }));
    } finally {
      setExporting(false);
    }
  }

  const memberName = new Map(members.map((m) => [m.id, m.name]));
  const columns: Column<AuditEntry, never>[] = [
    { id: "time", header: "Time", cell: (e) => <time dateTime={e.createdAt}>{formatDateTime(e.createdAt)}</time> },
    {
      id: "actor",
      header: "Actor",
      cell: (e) =>
        e.actorId ? (
          <span>
            {memberName.get(e.actorId) ?? e.actorLabel}
            <span className="block text-xs text-zinc-500">{e.actorLabel}</span>
          </span>
        ) : (
          <span className="text-zinc-500">{e.actorLabel === "system" ? "System" : "Unknown"}</span>
        ),
    },
    { id: "action", header: "Action", cell: (e) => AUDIT_ACTION_LABEL[e.action] },
    { id: "ip", header: "IP", cell: (e) => <span className="font-mono text-xs">{e.ip ?? "—"}</span> },
    { id: "details", header: "Details", cell: (e) => <Details entry={e} /> },
  ];

  const page = query.data;
  const loadingNewPage = query.isFetching && query.isPlaceholderData;
  const field = "rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-900";

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end gap-3">
        <label htmlFor={ids.actor} className="flex flex-col gap-1 text-sm font-medium">
          Actor
          <select id={ids.actor} value={filters.actor ?? ""} onChange={(e) => updateUrl({ actor: e.target.value || undefined })} className={field}>
            <option value="">Anyone</option>
            <option value={SYSTEM_ACTOR}>System</option>
            {members.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name} ({m.email})
              </option>
            ))}
          </select>
        </label>
        <label htmlFor={ids.action} className="flex flex-col gap-1 text-sm font-medium">
          Action
          <select
            id={ids.action}
            value={filters.action ?? ""}
            onChange={(e) => updateUrl({ action: (e.target.value || undefined) as AuditAction | undefined })}
            className={field}
          >
            <option value="">Any action</option>
            {AUDIT_ACTIONS.map((a) => (
              <option key={a} value={a}>
                {AUDIT_ACTION_LABEL[a]}
              </option>
            ))}
          </select>
        </label>
        <label htmlFor={ids.from} className="flex flex-col gap-1 text-sm font-medium">
          From (UTC)
          <input id={ids.from} type="date" value={filters.from ?? ""} max={filters.to} onChange={(e) => updateUrl({ from: e.target.value || undefined })} className={field} />
        </label>
        <label htmlFor={ids.to} className="flex flex-col gap-1 text-sm font-medium">
          To (UTC)
          <input id={ids.to} type="date" value={filters.to ?? ""} min={filters.from} onChange={(e) => updateUrl({ to: e.target.value || undefined })} className={field} />
        </label>
        {filtersKey && (
          <button type="button" onClick={() => updateUrl({ actor: undefined, action: undefined, from: undefined, to: undefined })} className="rounded-md px-3 py-1.5 text-sm font-medium hover:bg-zinc-100 dark:hover:bg-zinc-800">
            Clear filters
          </button>
        )}
        {canExport && (
          <button
            type="button"
            onClick={() => void exportCsv()}
            disabled={exporting}
            className="ml-auto rounded-md border border-zinc-300 px-3 py-1.5 text-sm font-medium hover:bg-zinc-100 disabled:opacity-50 dark:border-zinc-700 dark:hover:bg-zinc-800"
          >
            {exporting ? "Exporting…" : `Export CSV (max ${AUDIT_EXPORT_MAX_ROWS.toLocaleString("en-US")})`}
          </button>
        )}
      </div>
      {exportError && (
        <p role="alert" className="text-sm text-red-700 dark:text-red-300">
          {exportError}
        </p>
      )}

      {query.isError ? (
        <div role="alert" className="flex flex-col items-start gap-3 rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-200">
          <p>{query.error instanceof BffError ? adminErrorMessage(query.error) : "Something went wrong while loading the audit log."}</p>
          <button type="button" onClick={() => void query.refetch()} className="rounded-md bg-red-700 px-3 py-1.5 font-medium text-white hover:bg-red-800">
            Retry
          </button>
        </div>
      ) : !page ? (
        <TableSkeleton label="Loading audit log" />
      ) : (
        <>
          <DataTable
            caption="Audit log entries, newest first"
            columns={columns}
            rows={page.items}
            sort={{ key: "" as never, dir: "desc" }}
            onSortChange={() => {}}
            getRowId={(e) => String(e.id)}
            busy={query.isFetching}
            renderEmpty={() => <p className="text-zinc-500">No entries match these filters.</p>}
          />
          <nav aria-label="Pagination" className="flex items-center justify-between text-sm">
            <span className="text-zinc-500">
              Page {stack.length + 1}
              {loadingNewPage && " · Loading…"}
            </span>
            <div className="flex gap-2">
              <button type="button" onClick={() => setStack(stack.slice(0, -1))} disabled={stack.length === 0 || loadingNewPage} className="rounded-md border border-zinc-300 px-3 py-1.5 font-medium disabled:opacity-40 dark:border-zinc-700">
                Newer
              </button>
              <button type="button" onClick={() => page.nextCursor && setStack([...stack, page.nextCursor])} disabled={!page.nextCursor || loadingNewPage} className="rounded-md border border-zinc-300 px-3 py-1.5 font-medium disabled:opacity-40 dark:border-zinc-700">
                Older
              </button>
            </div>
          </nav>
        </>
      )}
    </div>
  );
}
