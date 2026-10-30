import type Database from "better-sqlite3";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { decodeCursor, DIRS, encodeCursor, SORTS, type Sort } from "../cursor.js";
import { CURRENCIES, STATUSES, type Currency, type Status } from "../db.js";
import { badRequest, orgExists, orgParams } from "./common.js";

const querySchema = z
  .object({
    status: z.enum(STATUSES).optional(),
    currency: z.enum(CURRENCIES).optional(),
    from: z.iso.date().optional(), // YYYY-MM-DD, inclusive (UTC)
    to: z.iso.date().optional(), // YYYY-MM-DD, inclusive (UTC)
    q: z.string().trim().min(1).max(100).optional(),
    sort: z.enum(SORTS).default("createdAt"),
    dir: z.enum(DIRS).default("desc"),
    cursor: z.string().min(1).max(500).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(25),
  })
  .strict()
  .refine((v) => !v.from || !v.to || v.from <= v.to, {
    message: "from must be on or before to",
    path: ["from"],
  });

// Whitelist: the only strings ever interpolated into SQL.
const SORT_COLUMN: Record<Sort, "created_at" | "amount"> = {
  createdAt: "created_at",
  amount: "amount",
};

type Row = {
  id: string;
  merchant: string;
  amount: number;
  currency: Currency;
  status: Status;
  created_at: string;
};

const nextDay = (date: string) =>
  new Date(Date.parse(`${date}T00:00:00.000Z`) + 86_400_000).toISOString();

const escapeLike = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

export function transactionsRoutes(app: FastifyInstance, db: Database.Database) {
  app.get("/orgs/:orgId/transactions", (req, reply) => {
    const params = orgParams.safeParse(req.params);
    if (!params.success) return badRequest(reply, params.error);
    const { orgId } = params.data;
    if (!orgExists(db, orgId)) return reply.code(404).send({ error: "org_not_found" });

    const parsed = querySchema.safeParse(req.query);
    if (!parsed.success) return badRequest(reply, parsed.error);
    const { status, currency, from, to, q, sort, dir, cursor: rawCursor, limit } = parsed.data;

    const col = SORT_COLUMN[sort];
    const where: string[] = ["org_id = ?"];
    const args: (string | number)[] = [orgId];

    if (status) {
      where.push("status = ?");
      args.push(status);
    }
    if (currency) {
      where.push("currency = ?");
      args.push(currency);
    }
    // created_at is always a UTC ISO string from toISOString(), so string compare is correct.
    if (from) {
      where.push("created_at >= ?");
      args.push(`${from}T00:00:00.000Z`);
    }
    if (to) {
      where.push("created_at < ?");
      args.push(nextDay(to));
    }
    if (q) {
      // SQLite LIKE is case-insensitive for ASCII.
      where.push("merchant LIKE ? ESCAPE '\\'");
      args.push(`%${escapeLike(q)}%`);
    }
    if (rawCursor) {
      const cursor = decodeCursor(rawCursor);
      if (!cursor) return reply.code(400).send({ error: "invalid_cursor" });
      if (cursor.s !== sort || cursor.d !== dir) {
        return reply.code(400).send({ error: "cursor_sort_mismatch" });
      }
      where.push(`(${col}, id) ${dir === "asc" ? ">" : "<"} (?, ?)`);
      args.push(cursor.v, cursor.id);
    }

    const sqlDir = dir === "asc" ? "ASC" : "DESC";
    const rows = db
      .prepare<(string | number)[], Row>(
        `SELECT id, merchant, amount, currency, status, created_at
         FROM transactions
         WHERE ${where.join(" AND ")}
         ORDER BY ${col} ${sqlDir}, id ${sqlDir}
         LIMIT ?`,
      )
      .all(...args, limit + 1);

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const last = page.at(-1);
    const nextCursor =
      hasMore && last
        ? encodeCursor(
            sort === "createdAt"
              ? { s: "createdAt", d: dir, v: last.created_at, id: last.id }
              : { s: "amount", d: dir, v: last.amount, id: last.id },
          )
        : null;

    return {
      items: page.map((r) => ({
        id: r.id,
        merchant: r.merchant,
        amount: r.amount,
        currency: r.currency,
        status: r.status,
        createdAt: r.created_at,
      })),
      nextCursor,
    };
  });
}
