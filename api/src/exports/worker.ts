import { exportFiltersSchema, formatMinorUnits, type ExportStatus, type Transaction } from "@mini-payments/shared";
import type { FastifyBaseLogger } from "fastify";
import type { Redis } from "ioredis";
import { randomBytes } from "node:crypto";
import { createWriteStream, type WriteStream } from "node:fs";
import { mkdir, readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { once } from "node:events";
import type { Clock } from "../auth/sessions.js";
import { csvAmount, csvLine, csvText } from "../csv.js";
import { withTransaction, type Db } from "../db.js";
import { publishOrgEvent } from "../events.js";
import { enqueueEvent } from "../outbox.js";
import { countTransactions, queryTransactionsPage } from "../transactionsQuery.js";
import { EXPORT_TTL_MS } from "./service.js";
import { createExportSlots } from "./slots.js";

export const CSV_HEADER = ["id", "created_at", "type", "status", "counterparty", "amount", "currency", "payout_id"];

/** One ledger row as CSV. Only `amount` (ours, from formatMinorUnits) skips the formula prefix. */
export function transactionCsvLine(t: Transaction): string {
  return csvLine([
    csvText(t.id),
    csvText(t.createdAt),
    csvText(t.type),
    csvText(t.status),
    csvText(t.merchant),
    csvAmount(formatMinorUnits(t.amount, t.currency)),
    csvText(t.currency),
    csvText(t.payoutId),
  ]);
}

export type ExportClaim = { id: string; orgId: string; attempts: number; filters: unknown };

/** The job failed for a reason worth showing its owner. */
class ExportFailure extends Error {}
/** Our claim was taken over (lease expired): stop quietly, the new owner carries on. */
class LostClaim extends Error {}

type Options = {
  db: Db;
  redis: Redis;
  exportDir: string;
  log: FastifyBaseLogger;
  prefix?: string;
  clock?: Clock;
  maxRows?: number;
  maxBytes?: number;
  pageSize?: number;
  leaseMs?: number;
  maxAttempts?: number;
};

export function createExportWorker({
  db,
  redis,
  exportDir,
  log,
  prefix = "",
  clock = Date.now,
  maxRows = 100_000,
  maxBytes = 50 * 1024 * 1024,
  pageSize = 1000,
  leaseMs = 60_000,
  maxAttempts = 3,
}: Options) {
  const iso = (ms = clock()) => new Date(ms).toISOString();
  const slots = createExportSlots(redis, { prefix, clock });

  /**
   * Claims up to `limit` runnable jobs: queued ones, and running ones whose lease ran out
   * (a crashed worker). SKIP LOCKED keeps workers apart; the Redis slot set keeps each
   * org to two running exports. A job whose org is at its limit stays queued.
   */
  async function claim(limit: number): Promise<ExportClaim[]> {
    return withTransaction(db, async (tx) => {
      const now = iso();
      const { rows } = await tx.query<{ id: string; org_id: string; attempts: number; status: ExportStatus; filters: unknown }>(
        `SELECT id, org_id, attempts, status, filters FROM export_jobs
         WHERE status = 'queued' OR (status = 'running' AND lease_expires_at <= $1)
         ORDER BY created_at, id
         LIMIT $2
         FOR UPDATE SKIP LOCKED`,
        [now, limit * 5],
      );
      const claims: ExportClaim[] = [];
      for (const r of rows) {
        if (claims.length >= limit) break;
        if (r.attempts >= maxAttempts) {
          // Crashed this often: stop retrying and say so.
          await tx.query(
            "UPDATE export_jobs SET status = 'failed', error = $2, lease_expires_at = NULL, completed_at = $3, expires_at = $4 WHERE id = $1",
            [r.id, `gave up after ${r.attempts} attempts`, now, iso(clock() + EXPORT_TTL_MS)],
          );
          await enqueueEvent(tx, r.org_id, { type: "export", exportId: r.id, status: "failed", rowsWritten: 0, rowsTotal: null }, now);
          continue;
        }
        if (!(await slots.acquire(r.org_id, r.id, leaseMs))) continue;
        await tx.query(
          `UPDATE export_jobs SET status = 'running', attempts = attempts + 1, lease_expires_at = $2,
                                  started_at = COALESCE(started_at, $3), rows_written = 0, bytes_written = 0, error = NULL
           WHERE id = $1`,
          [r.id, iso(clock() + leaseMs), now],
        );
        claims.push({ id: r.id, orgId: r.org_id, attempts: r.attempts + 1, filters: r.filters });
      }
      return claims;
    });
  }

  /** Records progress if the claim is still ours; extends both leases. */
  async function heartbeat(c: ExportClaim, rowsWritten: number, bytesWritten: number, rowsTotal: number | null) {
    const { rowCount } = await db.query(
      `UPDATE export_jobs SET rows_written = $3, bytes_written = $4, rows_total = $5, lease_expires_at = $6
       WHERE id = $1 AND attempts = $2 AND status = 'running'`,
      [c.id, c.attempts, rowsWritten, bytesWritten, rowsTotal, iso(clock() + leaseMs)],
    );
    if (!rowCount) throw new LostClaim();
    await slots.renew(c.orgId, c.id, leaseMs);
    // Progress is throwaway: straight to Redis. A missed tick is fixed by the next one,
    // and the page refetches on reconnect. Final states go through the outbox instead.
    await publishOrgEvent(redis, prefix, c.orgId, { type: "export", exportId: c.id, status: "running", rowsWritten, rowsTotal }).catch(
      (err: unknown) => log.warn({ err, exportId: c.id }, "export progress publish failed"),
    );
  }

  async function finish(c: ExportClaim, status: "completed" | "failed", fields: { fileName?: string; error?: string; rowsWritten: number; bytesWritten: number; rowsTotal: number | null }) {
    return withTransaction(db, async (tx) => {
      const now = iso();
      const { rowCount } = await tx.query(
        `UPDATE export_jobs SET status = $3, file_name = $4, error = $5, rows_written = $6, bytes_written = $7, rows_total = $8,
                                lease_expires_at = NULL, completed_at = $9, expires_at = $10
         WHERE id = $1 AND attempts = $2 AND status = 'running'`,
        [c.id, c.attempts, status, fields.fileName ?? null, fields.error ?? null, fields.rowsWritten, fields.bytesWritten, fields.rowsTotal, now, iso(clock() + EXPORT_TTL_MS)],
      );
      if (!rowCount) throw new LostClaim();
      await enqueueEvent(tx, c.orgId, { type: "export", exportId: c.id, status, rowsWritten: fields.rowsWritten, rowsTotal: fields.rowsTotal }, now);
    });
  }

  async function write(stream: WriteStream, chunk: string) {
    if (!stream.write(chunk)) await once(stream, "drain");
  }

  /** Streams the job's rows into a CSV file. Never throws: every outcome is recorded on the job. */
  async function run(c: ExportClaim): Promise<ExportStatus | "lost"> {
    await mkdir(exportDir, { recursive: true });
    // Random, not derived from anything the user sent.
    const fileName = `${c.id}-${randomBytes(8).toString("hex")}.csv`;
    const path = join(exportDir, fileName);
    const stream = createWriteStream(path, { flags: "wx", mode: 0o600 });
    let rowsWritten = 0;
    let bytesWritten = 0;
    let rowsTotal: number | null = null;
    try {
      const filters = exportFiltersSchema.parse(c.filters);
      // One snapshot for the whole file: rows arriving mid-export can't shift the pages.
      await withTransaction(
        db,
        async (snap) => {
          rowsTotal = await countTransactions(snap, c.orgId, filters);
          if (rowsTotal > maxRows) {
            throw new ExportFailure(`too many rows: ${rowsTotal} match, the limit is ${maxRows}. Narrow the filters.`);
          }
          await heartbeat(c, 0, 0, rowsTotal);
          const header = csvLine(CSV_HEADER);
          await write(stream, header);
          bytesWritten += Buffer.byteLength(header);

          let cursor: string | undefined;
          do {
            const page = await queryTransactionsPage(snap, c.orgId, filters, cursor, pageSize);
            const chunk = page.items.map(transactionCsvLine).join("");
            bytesWritten += Buffer.byteLength(chunk);
            if (bytesWritten > maxBytes) {
              throw new ExportFailure(`file too large: over the ${Math.round(maxBytes / 1024 / 1024)} MB limit. Narrow the filters.`);
            }
            await write(stream, chunk);
            rowsWritten += page.items.length;
            cursor = page.nextCursor ?? undefined;
            await heartbeat(c, rowsWritten, bytesWritten, rowsTotal);
          } while (cursor);
        },
        { isolation: "REPEATABLE READ" },
      );
      stream.end();
      await once(stream, "finish");
      await finish(c, "completed", { fileName, rowsWritten, bytesWritten, rowsTotal });
      return "completed";
    } catch (err) {
      stream.destroy();
      await rm(path, { force: true });
      if (err instanceof LostClaim) {
        log.warn({ exportId: c.id }, "lost the claim on an export, stopping");
        return "lost";
      }
      const message = err instanceof ExportFailure ? err.message : "the export failed unexpectedly";
      if (!(err instanceof ExportFailure)) log.error({ err, exportId: c.id }, "export crashed");
      await finish(c, "failed", { error: message, rowsWritten, bytesWritten, rowsTotal }).catch((e: unknown) => {
        if (!(e instanceof LostClaim)) throw e;
      });
      return "failed";
    } finally {
      await slots.release(c.orgId, c.id).catch(() => {});
    }
  }

  async function runOnce(concurrency: number): Promise<number> {
    const claims = await claim(concurrency);
    await Promise.all(
      claims.map(async (c) => {
        const outcome = await run(c);
        log.info({ exportId: c.id, orgId: c.orgId, outcome }, "export finished");
      }),
    );
    return claims.length;
  }

  /**
   * Deletes files of exports past their 24 h expiry (completed and failed) and marks them
   * expired. Also removes stray files no job points at (e.g. left by a crash), after an hour.
   */
  async function cleanup(): Promise<{ expired: number; strays: number }> {
    const now = iso();
    const { rows } = await db.query<{ id: string; file_name: string | null }>(
      `WITH due AS (
         SELECT id, file_name FROM export_jobs
         WHERE status IN ('completed', 'failed') AND expires_at <= $1
         FOR UPDATE SKIP LOCKED
       )
       UPDATE export_jobs j SET status = 'expired', file_name = NULL
       FROM due WHERE j.id = due.id
       RETURNING j.id, due.file_name`,
      [now],
    );
    for (const r of rows) if (r.file_name) await rm(join(exportDir, r.file_name), { force: true });

    let strays = 0;
    const files = await readdir(exportDir).catch(() => [] as string[]);
    if (files.length > 0) {
      const { rows: live } = await db.query<{ file_name: string }>(
        "SELECT file_name FROM export_jobs WHERE file_name IS NOT NULL OR status = 'running'",
      );
      const keep = new Set(live.map((l) => l.file_name));
      const running = (await db.query<{ id: string }>("SELECT id FROM export_jobs WHERE status = 'running'")).rows.map((r) => r.id);
      for (const f of files) {
        if (keep.has(f) || running.some((id) => f.startsWith(`${id}-`))) continue;
        const s = await stat(join(exportDir, f)).catch(() => null);
        if (s && clock() - s.mtimeMs > 60 * 60 * 1000) {
          await rm(join(exportDir, f), { force: true });
          strays++;
        }
      }
    }
    return { expired: rows.length, strays };
  }

  return { claim, run, runOnce, cleanup, slots };
}

export type ExportWorker = ReturnType<typeof createExportWorker>;
