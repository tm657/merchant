import type { FastifyInstance } from "fastify";
import {
  apiTransactionsQuerySchema as querySchema,
  type Currency,
  type Status,
  type TransactionType,
} from "@mini-payments/shared";
import { decodeCursor, encodeCursor, type Sort } from "../cursor.js";
import type { Db } from "../db.js";
import { badRequest, orgExists, orgParams } from "./common.js";

// Whitelist: the only strings ever interpolated into SQL.
const SORT_COLUMN: Record<Sort, "created_at" | "amount"> = {
  createdAt: "created_at",
  amount: "amount",
};

type Row = {
  id: string;
  type: TransactionType;
  merchant: string;
  amount: number;
  currency: Currency;
  status: Status;
  created_at: string;
  payout_id: string | null;
};

const nextDay = (date: string) =>
  new Date(Date.parse(`${date}T00:00:00.000Z`) + 86_400_000).toISOString();

const escapeLike = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

export function transactionsRoutes(app: FastifyInstance, db: Db) {
  app.get("/orgs/:orgId/transactions", async (req, reply) => {
    const params = orgParams.safeParse(req.params);
    if (!params.success) return badRequest(reply, params.error);
    const { orgId } = params.data;
    if (!(await orgExists(db, orgId))) return reply.code(404).send({ error: "org_not_found" });

    const parsed = querySchema.safeParse(req.query);
    if (!parsed.success) return badRequest(reply, parsed.error);
    const { type, status, currency, from, to, q, sort, dir, cursor: rawCursor, limit } = parsed.data;

    const col = SORT_COLUMN[sort];
    const args: (string | number)[] = [];
    // Adds a bind parameter and returns its placeholder ($1, $2, ...).
    const arg = (value: string | number) => `$${args.push(value)}`;
    const where: string[] = [`org_id = ${arg(orgId)}`];

    if (type) where.push(`type = ${arg(type)}`);
    if (status) where.push(`status = ${arg(status)}`);
    if (currency) where.push(`currency = ${arg(currency)}`);
    if (from) where.push(`created_at >= ${arg(`${from}T00:00:00.000Z`)}::timestamptz`);
    if (to) where.push(`created_at < ${arg(nextDay(to))}::timestamptz`);
    if (q) {
      // ILIKE: case-insensitive, like SQLite's LIKE was for ASCII.
      where.push(`merchant ILIKE ${arg(`%${escapeLike(q)}%`)} ESCAPE '\\'`);
    }
    if (rawCursor) {
      const cursor = decodeCursor(rawCursor);
      if (!cursor) return reply.code(400).send({ error: "invalid_cursor" });
      if (cursor.s !== sort || cursor.d !== dir) {
        return reply.code(400).send({ error: "cursor_sort_mismatch" });
      }
      const cast = sort === "createdAt" ? "timestamptz" : "bigint";
      // Row comparison on (sort column, id); ids are COLLATE "C", so ties break by byte order.
      where.push(`(${col}, id) ${dir === "asc" ? ">" : "<"} (${arg(cursor.v)}::${cast}, ${arg(cursor.id)})`);
    }

    const sqlDir = dir === "asc" ? "ASC" : "DESC";
    const { rows } = await db.query<Row>(
      `SELECT id, type, merchant, amount, currency, status, created_at, payout_id
       FROM transactions
       WHERE ${where.join(" AND ")}
       ORDER BY ${col} ${sqlDir}, id ${sqlDir}
       LIMIT ${arg(limit + 1)}`,
      args,
    );

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
        type: r.type,
        merchant: r.merchant,
        amount: r.amount,
        currency: r.currency,
        status: r.status,
        createdAt: r.created_at,
        payoutId: r.payout_id,
      })),
      nextCursor,
    };
  });
}
