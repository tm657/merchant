# mini-payments

A mini merchant payments dashboard, built as interview practice.

## Layout

An npm workspaces monorepo. Run `npm install` once at the repo root: there is one root `package-lock.json`, and the packages have no lockfiles of their own.

- `packages/shared/` (`@mini-payments/shared`): the contract both apps import. It holds the zod schemas, the permission map (`can`), roles, statuses, the currency list and the currency exponent table. It ships TypeScript source with no build step. Internal imports use explicit `.ts` extensions (`./schemas.ts`), because Turbopack does not map `.js` to `.ts`.
- `web/`: Next.js (App Router), TypeScript, Tailwind, TanStack Query, zod. Acts as a backend-for-frontend (BFF). Runs on port **3000**.
- `api/`: Node 20.12+ TypeScript service using Fastify, pg (Postgres), ioredis (Redis), node-pg-migrate, zod, and tsx. Runs on port **4000**. Several instances can run side by side: everything they share lives in Postgres or Redis.
- `docker-compose.yml`: Postgres 16 and Redis 7 for local development, bound to 127.0.0.1.
- **Postgres** holds all app data, including sessions. **Redis** holds rate-limit counters and carries live events (pub/sub) between API instances.
- **Webhook worker** (`api/src/webhook-worker.ts`, `npm run dev:webhooks`): a separate process that delivers webhooks. Deliveries are created by the outbox publisher in the pay-out worker, so both must run. `api/scripts/webhook-receiver.ts` (`npm run webhook-receiver`) is a local receiver that verifies signatures, for demos.
- **Pay-out worker** (`api/src/worker.ts`, `npm run dev:worker`): a separate process that sends approved pay-outs to the simulated provider, publishes the outbox to Redis, and deletes old idempotency keys and outbox rows. Without it, pay-outs stay `approved` and no live pay-out or balance events reach the browser for pay-out changes. Any number of workers can run at once.
- `web/` uses a newer Next.js with breaking changes. Read `web/AGENTS.md` and the docs in `web/node_modules/next/dist/docs/` before writing Next.js code.

## Rules

- **Money**: always an integer amount in minor units plus a currency code (e.g. `{ amount: 1999, currency: "EUR" }`). Never use floats for money, in storage, transport, or math. Format for display only at render time. Postgres money columns are `BIGINT`. The pool parses `BIGINT` into a JS number and throws past `Number.MAX_SAFE_INTEGER` rather than rounding.
- **Currency exponents** come from `CURRENCY_EXPONENT` in shared: USD 2, PHP 2, **IDR 0** (whole rupiah, our choice: ISO 4217 lists 2). Never hardcode `/ 100` or a decimal count; convert whole major units with `majorToMinor`. To add a currency, add it to `CURRENCIES` and `CURRENCY_EXPONENT`, then add a migration that updates the `CHECK` constraints.
- **One contract**: schemas, permissions, roles, statuses and currencies are defined only in `packages/shared`. Never copy them into `api/` or `web/`. Code that belongs to one app stays in that app (e.g. the cursor codec in the API, the URL filter helpers in `web/lib/filters.ts`). The API enforces `can()`. The web app uses it only to hide UI.
- **BFF boundary**: the browser never calls the API directly. Client code calls Next.js route handlers in `web/app/api/...`, and those call the API using `API_URL`.
- **State holds inputs only**: keep filters, sort, and cursor in state. Derive rows from those inputs (via the query). Never store sorted or filtered copies of data.
- **URL is the source of truth** for filters and sort, so views are shareable and survive reload.
- **Pagination is cursor-based**: no offset/page-number pagination.
- **Validate at boundaries with zod**: API request input, API responses parsed in the BFF, BFF responses parsed in the client, and environment variables at startup.
- **Config**: read environment variables only in the config modules (`api/src/config.ts`, `web/lib/config.server.ts`), never via `process.env` elsewhere. A new variable goes in the zod schema and in that app's `.env.example`. Bad config must stop the process at startup (the API in `loadConfig`, the web app in `instrumentation.ts`). `API_URL` is server-only: never expose it to the browser.
- **Postgres conventions**: always use bind parameters (`$1`), never interpolate values. The only strings interpolated into SQL are whitelisted column names. Timestamps are `TIMESTAMPTZ(3)` (milliseconds, like JS `Date`), and the pool returns them as ISO strings. Id columns are `COLLATE "C"` (byte order): ids break ties in keyset pagination, so their order must not depend on locale. Multi-statement writes go through `withTransaction`. Publish events only after the transaction commits.
- **Shared state lives in Redis or Postgres, never in process memory** (except per-connection things like open SSE streams), because the API and the worker may run as several instances. Rate limits are atomic Lua scripts in `auth/rateLimit.ts` that take time from the app clock. Live events go through `EventBus` (Redis pub/sub, channel `events:org:<orgId>`). Store only hashes of user identifiers (e.g. emails) in Redis keys, and give every key a TTL.
- **Fail closed when Redis is down**: login and register return 503 (`service_unavailable`, `retry-after`) instead of skipping their rate limits, and opening an event stream returns 503. Never let a dependency outage turn into "no limit".
- **Pay-out state machine** lives in shared (`canTransition`): `pending_approval → approved | rejected | cancelled`, `approved → processing`, `processing → paid | failed`. Never change a pay-out's status without checking it there, and answer a disallowed change with 409 `invalid_transition`.
- **Pay-out writes** lock the pay-out row (`SELECT … FOR UPDATE`), check `version` (stale → 409 `version_conflict`), check the transition, then bump `version`. In the same transaction they write a `payout_events` row (the timeline) and an outbox row. Lock order is always the pay-out row, then the balance row.
- **Four eyes**: nobody approves or rejects their own pay-out. Return 403 (`self_approval_forbidden` / `self_rejection_forbidden`); the `payouts_not_self_decided` CHECK constraint is the backstop. UI controls follow `can()` and are never shown on your own pay-outs.
- **Funds**: approval moves the amount from `balances.available` to `reserved` after locking the balance row and checking funds (409 `insufficient_funds`). Paid releases `reserved`. Failed returns it to `available`. Both columns have `CHECK (>= 0)`.
- **Outbox, not direct publishing**: state changes that clients must hear about write to `outbox` inside their transaction (`enqueueEvent`); the worker publishes after commit. Delivery is at-least-once, so events carry `version` and clients refetch rather than trusting event payloads blindly. (The transaction simulator still publishes directly; it isn't part of the pay-out flow.)
- **Idempotent creates**: `POST …/payouts` requires an `Idempotency-Key` header. The key row, the pay-out and the stored response commit in one transaction. Same key + same body (hash of user id and canonical body) replays the stored response with `Idempotent-Replayed: true`; a different body → 422 `idempotency_key_reused`. The web form generates the key when it opens and reuses it for every retry. A new key is only made for a new form. Known keys skip the per-user create rate limit, so retries always work.
- **Worker claims** use `FOR UPDATE SKIP LOCKED` and a lease (`lease_expires_at`). Provider calls happen outside any transaction. `attempts` is the fencing token: completion only applies while the row still has the attempt number it claimed. The provider must be idempotent per pay-out id. Transient errors are retried with exponential backoff (`next_attempt_at`) up to `PAYOUT_MAX_ATTEMPTS`, then the pay-out fails and its funds are returned.
- **Money input**: parse what people type with `parseMoneyInput` from shared (string arithmetic, rejects extra decimals). Never `parseFloat` an amount.
- **Accessible dialogs**: use `components/Dialog.tsx` (native modal `<dialog>`, focus trap, Escape, focus return). Announce outcomes through `useAnnounce()` (one polite live region per page). Show errors that need attention with `role="alert"` where they occur.
- **Simulator**: with several API instances, run it on exactly one (`SIMULATOR=off` on the rest).
- **Migrations**: every Postgres schema change is a new SQL file in `api/migrations/`, created with `npm run migrate:create -w api -- <name>`, and applied with `npm run db:migrate`. It needs both `-- Up Migration` and `-- Down Migration` sections. Never edit a migration that has already been applied: add a new one instead.
- **Request IDs**: the web proxy (`web/proxy.ts`) gives every request a fresh `x-request-id`, and the BFF forwards it to the API. The API reuses it if it is well formed, or generates one. Both apps echo it in the response. Every log line must carry it: use `req.log` in the API (never `app.log` or `console` inside a request) and `log` from `web/lib/log.server.ts` in the BFF (never `console`).
- **Health**: `/healthz` (liveness) must never touch dependencies. `/readyz` checks every dependency (Postgres, and Redis including the pub/sub connection) and returns 503 if any is down. When adding a dependency, add a readiness check for it in `buildApp` (`app.ts`). Responses show only ok/error per check: details go to the logs.
- **Database roles**: the API and workers connect with `DATABASE_URL` as a login role in `payments_app`: never a superuser, never the owner of the tables (`assertAppRole` refuses to start otherwise). Migrations and the seed use `MIGRATION_DATABASE_URL` (the owner). `db:migrate` creates or updates the login role from `DATABASE_URL`. Default privileges give new tables SELECT/INSERT/UPDATE/DELETE to `payments_app`. A table that must be more restricted needs an explicit `REVOKE` in its migration, as `audit_log` has.
- **Audit log**: every security-relevant action writes exactly one entry with `audit(tx, ctx, …)`, using the action's own transaction, so the entry exists if and only if the action committed. This covers login, logout, pay-out transitions, webhook changes and exports. Add new actions to `AUDIT_ACTIONS` in shared. Build the context with `requestContext(req, userId)` (IP, user agent, request id), or use `SYSTEM` in workers. Metadata never holds passwords, tokens, secrets, full account numbers or full webhook URLs (hosts only).
- **The audit log is append-only**: the app role has no UPDATE, DELETE or TRUNCATE on it, and triggers refuse them for everyone. There are no foreign keys, so entries outlive deleted users and orgs. Never "fix" an entry: write a new one. `db:seed` never clears it.
- **Webhook events** are enqueued with `enqueueWebhookEvent(tx, …)` in the transaction that caused them. The payload is a snapshot of the object at that moment (integer minor units, masked account numbers). The outbox publisher fans them out to `webhook_deliveries`, idempotent per (endpoint, event). A new event type goes in `WEBHOOK_EVENT_TYPES` in shared.
- **Outbound HTTP to user-supplied URLs goes only through `sendWebhook`** (`api/src/webhooks/http.ts`). It enforces the SSRF rules:
  - HTTPS only in production, and no credentials in URLs.
  - DNS is resolved and every address checked, and the connection pins the vetted address.
  - Private, loopback, link-local, reserved and IPv4-in-IPv6 addresses are blocked.
  - No redirects, a 5 s timeout and a 64 KB response cap.
  - URLs are validated with `validateWebhookTarget` when saved, and checked again on every delivery.
  - `WEBHOOK_ALLOW_PRIVATE_TARGETS=true` allows only loopback and private ranges, for the local demo. Config refuses it in production. Link-local (cloud metadata) is never allowed.
- **Webhook secrets** are encrypted with AES-256-GCM using `WEBHOOK_SECRET_KEY`, with the endpoint id as AAD. They're returned only by create and rotate (the UI shows them once), and are never logged, audited or cached. Rotation keeps the old secret co-signing for 24 h (a second `v1=`). Requests are signed `Webhook-Signature: t=<unix>,v1=<HMAC-SHA256(secret, t + "." + body)>`, and receivers should dedupe on `Webhook-Id`.
- **Webhook deliveries** use the same pattern as pay-outs: claim with `FOR UPDATE SKIP LOCKED` under a lease, make the HTTP call outside any transaction, and use `attempts` as the fencing token. Backoff is exponential (5 s base), and a delivery is marked `dead` after `WEBHOOK_MAX_ATTEMPTS` (8). Redelivery is a new row with the same body and event id.
- **CSV exports** neutralise formula prefixes (`= + - @`) and quote per RFC 4180. They are capped (`AUDIT_EXPORT_MAX_ROWS`), audited in the same transaction, and use POST (with the CSRF check), because exporting is an action.
- **Local services bind to 127.0.0.1**, including ports in `docker-compose.yml`.
- **Secrets and data stay out of git**: `.env*` files are gitignored, except `.env.example`, which must never contain real secrets. Seed passwords (`api/seed-users.local.json`) are gitignored too. Never commit them.

## After each task

Run lint and type-check in each package you touched, and fix every error before finishing:

```bash
# everything, from the repo root
npm run lint && npm run typecheck

# or one package
npm run lint -w web && npm run typecheck -w web   # typecheck runs `next typegen` first, so new routes are typed
npm run lint -w api && npm run typecheck -w api && npm test -w api
npm run lint -w @mini-payments/shared && npm run typecheck -w @mini-payments/shared
```

A change to `packages/shared` affects both apps, so type-check all three.

API tests need the docker-compose services running (`npm run db:up`) and `MIGRATION_DATABASE_URL` in `api/.env`. They never touch dev data: each test app migrates its own throwaway schema in the `payments_test` database as the owner, connects as its own app login role (`payments_app_test`, so privileges are tested for real) and uses its own key prefix in Redis db 15, and all of it is removed afterwards. Override with `TEST_DATABASE_URL` / `TEST_REDIS_URL`. Test behaviour against real Postgres and Redis, not mocks.

Then tell the user the exact commands to run the change and what they should see (e.g. which URL to open, expected output or UI state).

## Running locally

```bash
npm install                          # once, at the repo root
cp api/.env.example api/.env         # once; then set WEBHOOK_SECRET_KEY (openssl rand -base64 32)
cp web/.env.example web/.env.local   # once
npm run db:up                        # Postgres + Redis, waits until both are healthy
npm run db:migrate                   # apply pending migrations and create the app login role
npm run db:seed                      # (re)creates the demo data, incl. 3 pending pay-outs in org_1; passwords in api/seed-users.local.json

npm run dev:api        # API on http://localhost:4000 (check http://localhost:4000/readyz)
npm run dev:worker     # pay-out worker + outbox publisher (no port)
npm run dev:webhooks   # webhook delivery worker (no port)
npm run dev:web        # web on http://localhost:3000

# optional, for webhook demos: point an endpoint at http://127.0.0.1:4500/webhooks
WEBHOOK_SECRET=whsec_... npm run webhook-receiver
```

Roll back the last migration with `npm run db:migrate -- down`. `npm run db:seed` truncates every table first.
