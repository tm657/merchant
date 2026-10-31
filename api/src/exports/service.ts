import { EXPORT_TTL_HOURS, MAX_PENDING_EXPORTS_PER_ORG, type ExportFilters, type ExportJob, type ExportStatus } from "@mini-payments/shared";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { audit, type AuditContext } from "../audit.js";
import type { Clock } from "../auth/sessions.js";
import { withTransaction, type Db, type Queryable } from "../db.js";

export class ExportError extends Error {
  constructor(
    readonly status: 404 | 409 | 410 | 429,
    readonly code: string,
  ) {
    super(code);
    this.name = "ExportError";
  }
}

type Row = {
  id: string;
  org_id: string;
  status: ExportStatus;
  filters: Record<string, unknown>;
  requested_by: string;
  requested_by_name: string | null;
  rows_total: number | null;
  rows_written: number;
  bytes_written: number;
  file_name: string | null;
  error: string | null;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
  expires_at: string | null;
};

const SELECT = `SELECT j.id, j.org_id, j.status, j.filters, j.requested_by, u.name AS requested_by_name, j.rows_total,
                       j.rows_written, j.bytes_written, j.file_name, j.error, j.created_at, j.started_at,
                       j.completed_at, j.expires_at
                FROM export_jobs j LEFT JOIN users u ON u.id = j.requested_by`;

export function toExportJob(r: Row, now: number): ExportJob {
  return {
    id: r.id,
    status: r.status,
    filters: r.filters,
    requestedBy: { id: r.requested_by, name: r.requested_by_name ?? "Deleted user" },
    rowsTotal: r.rows_total,
    rowsWritten: r.rows_written,
    bytesWritten: r.bytes_written,
    error: r.error,
    createdAt: r.created_at,
    startedAt: r.started_at,
    completedAt: r.completed_at,
    expiresAt: r.expires_at,
    downloadable: r.status === "completed" && r.expires_at !== null && Date.parse(r.expires_at) > now,
  };
}

/** The name the browser saves the file as: no user input in it. */
export function downloadName(job: { id: string; org_id: string; completed_at: string | null }): string {
  const day = (job.completed_at ?? new Date().toISOString()).slice(0, 10);
  return `transactions-${job.org_id}-${day}-${job.id.slice(4, 12)}.csv`;
}

export const EXPORT_TTL_MS = EXPORT_TTL_HOURS * 60 * 60 * 1000;

export function createExportService(db: Db, exportDir: string, clock: Clock = Date.now) {
  const iso = () => new Date(clock()).toISOString();

  async function load(q: Queryable, orgId: string, id: string): Promise<Row> {
    const { rows } = await q.query<Row>(`${SELECT} WHERE j.org_id = $1 AND j.id = $2`, [orgId, id]);
    if (!rows[0]) throw new ExportError(404, "export_not_found");
    return rows[0];
  }

  return {
    /** Queues an export of the transactions list with these filters. Audited in the same transaction. */
    async create(orgId: string, ctx: AuditContext & { actorId: string }, filters: ExportFilters): Promise<ExportJob> {
      return withTransaction(db, async (tx) => {
        const now = iso();
        // Serialise creates per org so the pending cap can't be raced past.
        await tx.query("SELECT pg_advisory_xact_lock(hashtext('mini-payments:exports:' || $1))", [orgId]);
        const { rows: pending } = await tx.query<{ n: number }>(
          "SELECT count(*) AS n FROM export_jobs WHERE org_id = $1 AND status IN ('queued', 'running')",
          [orgId],
        );
        if (pending[0]!.n >= MAX_PENDING_EXPORTS_PER_ORG) throw new ExportError(429, "too_many_exports");
        const id = `exp_${randomUUID()}`;
        await tx.query(
          `INSERT INTO export_jobs (id, org_id, requested_by, filters, status, created_at)
           VALUES ($1, $2, $3, $4, 'queued', $5)`,
          [id, orgId, ctx.actorId, JSON.stringify(filters), now],
        );
        await audit(tx, ctx, { orgId, action: "report.export.requested", targetType: "export", targetId: id, metadata: { filters } }, now);
        return toExportJob(await load(tx, orgId, id), clock());
      });
    },

    async list(orgId: string): Promise<ExportJob[]> {
      const { rows } = await db.query<Row>(`${SELECT} WHERE j.org_id = $1 ORDER BY j.created_at DESC, j.id DESC LIMIT 50`, [orgId]);
      return rows.map((r) => toExportJob(r, clock()));
    },

    async get(orgId: string, id: string): Promise<ExportJob> {
      return toExportJob(await load(db, orgId, id), clock());
    },

    /**
     * Authorises one download: the job must belong to the org, be completed, not be past
     * its expiry, and its file must still exist. Records the download in the audit log.
     */
    async openDownload(orgId: string, ctx: AuditContext, id: string): Promise<{ path: string; name: string; size: number }> {
      return withTransaction(db, async (tx) => {
        const job = await load(tx, orgId, id);
        if (job.status === "expired" || (job.expires_at && Date.parse(job.expires_at) <= clock())) {
          throw new ExportError(410, "export_expired");
        }
        if (job.status !== "completed" || !job.file_name) throw new ExportError(409, "export_not_ready");
        const path = join(exportDir, job.file_name);
        const size = await stat(path).then(
          (s) => s.size,
          () => {
            throw new ExportError(410, "export_expired");
          },
        );
        await audit(
          tx,
          ctx,
          { orgId, action: "report.export.downloaded", targetType: "export", targetId: id, metadata: { rows: job.rows_written, bytes: size } },
          iso(),
        );
        return { path, name: downloadName(job), size };
      });
    },
  };
}

export type ExportService = ReturnType<typeof createExportService>;
