import { AUDIT_EXPORT_MAX_ROWS, SYSTEM_ACTOR, type AuditAction, type AuditEntry, type AuditFilters } from "@mini-payments/shared";
import { z } from "zod";
import { audit, type AuditContext } from "./audit.js";
import type { Clock } from "./auth/sessions.js";
import { withTransaction, type Db, type Queryable } from "./db.js";

type Row = {
  id: number;
  org_id: string | null;
  actor_id: string | null;
  actor_label: string;
  action: AuditAction;
  target_type: string | null;
  target_id: string | null;
  metadata: Record<string, unknown>;
  ip: string | null;
  user_agent: string | null;
  request_id: string | null;
  created_at: string;
};

const toEntry = (r: Row): AuditEntry => ({
  id: r.id,
  orgId: r.org_id,
  actorId: r.actor_id,
  actorLabel: r.actor_label,
  action: r.action,
  targetType: r.target_type,
  targetId: r.target_id,
  metadata: r.metadata,
  ip: r.ip,
  userAgent: r.user_agent,
  requestId: r.request_id,
  createdAt: r.created_at,
});

const cursorSchema = z.object({ v: z.iso.datetime(), id: z.number().int() });
const encodeCursor = (c: z.infer<typeof cursorSchema>) => Buffer.from(JSON.stringify(c)).toString("base64url");
function decodeCursor(raw: string) {
  try {
    return cursorSchema.parse(JSON.parse(Buffer.from(raw, "base64url").toString("utf8")));
  } catch {
    return null;
  }
}

export class AuditQueryError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

const nextDay = (date: string) => new Date(Date.parse(`${date}T00:00:00.000Z`) + 86_400_000).toISOString();

/**
 * What an org's admins may see: the org's own entries, plus user-level entries (login,
 * logout: org_id NULL) whose actor or target user is a member of the org. Failed logins
 * for unknown emails have neither, so they're only visible in the database.
 */
function where(orgId: string, f: AuditFilters, args: unknown[]) {
  const arg = (v: unknown) => `$${args.push(v)}`;
  const org = arg(orgId);
  const members = `(SELECT user_id FROM memberships WHERE org_id = ${org})`;
  const clauses = [
    `(a.org_id = ${org} OR (a.org_id IS NULL AND (a.actor_id IN ${members} OR (a.target_type = 'user' AND a.target_id IN ${members}))))`,
  ];
  if (f.actor === SYSTEM_ACTOR) clauses.push("a.actor_id IS NULL AND a.actor_label = 'system'");
  else if (f.actor) clauses.push(`a.actor_id = ${arg(f.actor)}`);
  if (f.action) clauses.push(`a.action = ${arg(f.action)}`);
  if (f.from) clauses.push(`a.created_at >= ${arg(`${f.from}T00:00:00.000Z`)}::timestamptz`);
  if (f.to) clauses.push(`a.created_at < ${arg(nextDay(f.to))}::timestamptz`);
  return clauses;
}

const SELECT = `SELECT a.id, a.org_id, a.actor_id, a.actor_label, a.action, a.target_type, a.target_id, a.metadata,
                       host(a.ip) AS ip, a.user_agent, a.request_id, a.created_at
                FROM audit_log a`;

/** RFC 4180 quoting, plus a leading ' on anything a spreadsheet would run as a formula. */
function csvCell(value: unknown): string {
  let s = value === null || value === undefined ? "" : typeof value === "string" ? value : JSON.stringify(value);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
}

const CSV_COLUMNS = [
  "id",
  "createdAt",
  "actorId",
  "actorLabel",
  "action",
  "targetType",
  "targetId",
  "ip",
  "userAgent",
  "requestId",
  "metadata",
] as const satisfies readonly (keyof AuditEntry)[];

export function createAuditLog(db: Db, clock: Clock = Date.now) {
  async function query(q: Queryable, orgId: string, f: AuditFilters, cursor: string | undefined, limit: number) {
    const args: unknown[] = [];
    const clauses = where(orgId, f, args);
    if (cursor) {
      const c = decodeCursor(cursor);
      if (!c) throw new AuditQueryError("invalid_cursor");
      clauses.push(`(a.created_at, a.id) < ($${args.push(c.v)}::timestamptz, $${args.push(c.id)})`);
    }
    const { rows } = await q.query<Row>(
      `${SELECT} WHERE ${clauses.join(" AND ")} ORDER BY a.created_at DESC, a.id DESC LIMIT $${args.push(limit)}`,
      args,
    );
    return rows;
  }

  return {
    /** Newest first, keyset on (created_at, id). */
    async list(orgId: string, f: AuditFilters & { cursor?: string; limit: number }) {
      const rows = await query(db, orgId, f, f.cursor, f.limit + 1);
      const hasMore = rows.length > f.limit;
      const page = hasMore ? rows.slice(0, f.limit) : rows;
      const last = page.at(-1);
      return { items: page.map(toEntry), nextCursor: hasMore && last ? encodeCursor({ v: last.created_at, id: last.id }) : null };
    },

    /**
     * CSV of up to AUDIT_EXPORT_MAX_ROWS matching entries, newest first. The read and the
     * "audit.exported" entry share one REPEATABLE READ transaction, so the entry records
     * exactly what was exported.
     */
    async exportCsv(orgId: string, ctx: AuditContext, f: AuditFilters) {
      return withTransaction(
        db,
        async (tx) => {
          const rows = (await query(tx, orgId, f, undefined, AUDIT_EXPORT_MAX_ROWS + 1)).map(toEntry);
          const truncated = rows.length > AUDIT_EXPORT_MAX_ROWS;
          const entries = rows.slice(0, AUDIT_EXPORT_MAX_ROWS);
          await audit(
            tx,
            ctx,
            { orgId, action: "audit.exported", metadata: { filters: f, rows: entries.length, truncated } },
            new Date(clock()).toISOString(),
          );
          const lines = [CSV_COLUMNS.join(","), ...entries.map((e) => CSV_COLUMNS.map((c) => csvCell(e[c])).join(","))];
          return { csv: `${lines.join("\r\n")}\r\n`, rows: entries.length, truncated };
        },
        { isolation: "REPEATABLE READ" },
      );
    },
  };
}

export type AuditLog = ReturnType<typeof createAuditLog>;
