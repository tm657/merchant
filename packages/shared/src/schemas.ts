import { z } from "zod";
import { CURRENCIES } from "./currency.ts";
import { ROLES } from "./permissions.ts";

// The API contract. The API validates requests with these; the BFF parses API responses
// with them; the browser parses BFF responses with them.

export const STATUSES = ["pending", "success", "failed"] as const;
export type Status = (typeof STATUSES)[number];

export const SORTS = ["createdAt", "amount"] as const;
export type SortKey = (typeof SORTS)[number];

export const DIRS = ["asc", "desc"] as const;
export type SortDir = (typeof DIRS)[number];

export const DEFAULT_SORT: SortKey = "createdAt";
export const DEFAULT_DIR: SortDir = "desc";
export const DEFAULT_PAGE_SIZE = 25;
export const MAX_PAGE_SIZE = 100;

export const orgIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
export const orgParamsSchema = z.object({ orgId: orgIdSchema });

/** Integer minor units. See CURRENCY_EXPONENT. */
export const minorUnitsSchema = z.number().int();
export const currencySchema = z.enum(CURRENCIES);

export const errorBodySchema = z.object({ error: z.string() });

// ---- Transactions ----------------------------------------------------------

export const transactionSchema = z.object({
  id: z.string(),
  merchant: z.string(),
  amount: minorUnitsSchema,
  currency: currencySchema,
  status: z.enum(STATUSES),
  createdAt: z.iso.datetime(),
});
export type Transaction = z.infer<typeof transactionSchema>;

export const transactionsPageSchema = z.object({
  items: z.array(transactionSchema),
  nextCursor: z.string().nullable(),
});
export type TransactionsPage = z.infer<typeof transactionsPageSchema>;

const transactionsQueryFields = {
  status: z.enum(STATUSES).optional(),
  currency: currencySchema.optional(),
  from: z.iso.date().optional(), // YYYY-MM-DD, inclusive (UTC)
  to: z.iso.date().optional(), // YYYY-MM-DD, inclusive (UTC)
  q: z.string().trim().min(1).max(100).optional(),
  cursor: z.string().min(1).max(500).optional(),
};

const validRange = (v: { from?: string; to?: string }) => !v.from || !v.to || v.from <= v.to;
const rangeError = { message: "from must be on or before to", path: ["from"] };

/** BFF route input. Strict: unknown or bad params are a 400. Only set values are forwarded. */
export const transactionsQuerySchema = z
  .object({
    ...transactionsQueryFields,
    sort: z.enum(SORTS).optional(),
    dir: z.enum(DIRS).optional(),
    limit: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).optional(),
  })
  .strict()
  .refine(validRange, rangeError);
export type TransactionsQuery = z.infer<typeof transactionsQuerySchema>;

/** API route input: same rules as the BFF, with defaults filled in. */
export const apiTransactionsQuerySchema = z
  .object({
    ...transactionsQueryFields,
    sort: z.enum(SORTS).default(DEFAULT_SORT),
    dir: z.enum(DIRS).default(DEFAULT_DIR),
    limit: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(DEFAULT_PAGE_SIZE),
  })
  .strict()
  .refine(validRange, rangeError);

// ---- Balances --------------------------------------------------------------

export const balanceSchema = z.object({ currency: currencySchema, available: minorUnitsSchema });
export const balancesSchema = z.object({ balances: z.array(balanceSchema) });
export type Balances = z.infer<typeof balancesSchema>;

// ---- Live events (SSE) -----------------------------------------------------

export const balanceEventSchema = balanceSchema;
export type BalanceEvent = z.infer<typeof balanceEventSchema>;

export const transactionsEventSchema = z.object({ count: z.number().int().positive() });

// ---- Auth ------------------------------------------------------------------

export const PASSWORD_MIN_LENGTH = 12;
// Caps the work an attacker can force per request.
export const PASSWORD_MAX_LENGTH = 256;

const emailSchema = z.string().trim().toLowerCase().pipe(z.email().max(254));

export const loginBodySchema = z.object({
  email: emailSchema,
  // No minimum here: a login must not reveal the password policy's edge cases.
  password: z.string().min(1).max(PASSWORD_MAX_LENGTH),
});

export const registerBodySchema = z.object({
  name: z.string().trim().min(1).max(100),
  email: emailSchema,
  password: z.string().min(PASSWORD_MIN_LENGTH).max(PASSWORD_MAX_LENGTH),
});

const userSchema = z.object({ id: z.string(), email: z.string(), name: z.string() });

export const loginResponseSchema = z.object({
  token: z.string().min(1),
  expiresAt: z.iso.datetime(),
  user: userSchema,
});

export const meSchema = z.object({
  user: userSchema,
  memberships: z.array(z.object({ orgId: z.string(), orgName: z.string(), role: z.enum(ROLES) })),
  session: z.object({ expiresAt: z.iso.datetime() }),
});
export type Me = z.infer<typeof meSchema>;

// ---- Request IDs -----------------------------------------------------------

export const REQUEST_ID_HEADER = "x-request-id";

/** Accepts only short, log-safe IDs from upstream; anything else is replaced. */
export const requestIdSchema = z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/);
