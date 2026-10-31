# mini-payments

A mini merchant payments dashboard, built as interview practice.

## Layout

An npm workspaces monorepo. Run `npm install` once at the repo root: there is one root `package-lock.json`, and the packages have no lockfiles of their own.

- `packages/shared/` (`@mini-payments/shared`): the contract both apps import. It holds the zod schemas, the permission map (`can`), roles, statuses, the currency list and the ISO 4217 currency exponent table. It ships TypeScript source with no build step. Internal imports use explicit `.ts` extensions (`./schemas.ts`), because Turbopack does not map `.js` to `.ts`.
- `web/`: Next.js (App Router), TypeScript, Tailwind, TanStack Query, zod. Acts as a backend-for-frontend (BFF). Runs on port **3000**.
- `api/`: Node 20.12+ TypeScript service using Fastify, better-sqlite3, pg, ioredis, zod, and tsx. Runs on port **4000**.
- `docker-compose.yml`: Postgres 16 and Redis 7 for local development, bound to 127.0.0.1.
- App data still lives in SQLite (`api/data/payments.db`). Postgres has the schema (via migrations) but no data yet. Redis is only health-checked so far.
- `web/` uses a newer Next.js with breaking changes. Read `web/AGENTS.md` and the docs in `web/node_modules/next/dist/docs/` before writing Next.js code.

## Rules

- **Money**: always an integer amount in minor units plus a currency code (e.g. `{ amount: 1999, currency: "EUR" }`). Never use floats for money, in storage, transport, or math. Format for display only at render time. Postgres money columns are `BIGINT`.
- **Currency exponents** come from `CURRENCY_EXPONENT` in shared (ISO 4217). Never hardcode `/ 100` or a decimal count. To add a currency, add it to `CURRENCIES` and `CURRENCY_EXPONENT`, then add a migration that updates the `CHECK` constraints.
- **One contract**: schemas, permissions, roles, statuses and currencies are defined only in `packages/shared`. Never copy them into `api/` or `web/`. Code that belongs to one app stays in that app (e.g. the cursor codec in the API, the URL filter helpers in `web/lib/filters.ts`). The API enforces `can()`. The web app uses it only to hide UI.
- **BFF boundary**: the browser never calls the API directly. Client code calls Next.js route handlers in `web/app/api/...`, and those call the API using `API_URL`.
- **State holds inputs only**: keep filters, sort, and cursor in state. Derive rows from those inputs (via the query). Never store sorted or filtered copies of data.
- **URL is the source of truth** for filters and sort, so views are shareable and survive reload.
- **Pagination is cursor-based**: no offset/page-number pagination.
- **Validate at boundaries with zod**: API request input, API responses parsed in the BFF, BFF responses parsed in the client, and environment variables at startup.
- **Config**: read environment variables only in the config modules (`api/src/config.ts`, `web/lib/config.server.ts`), never via `process.env` elsewhere. A new variable goes in the zod schema and in that app's `.env.example`. Bad config must stop the process at startup (the API in `loadConfig`, the web app in `instrumentation.ts`). `API_URL` is server-only: never expose it to the browser.
- **Migrations**: every Postgres schema change is a new SQL file in `api/migrations/`, created with `npm run migrate:create -w api -- <name>`. It needs both `-- Up Migration` and `-- Down Migration` sections. Never edit a migration that has already been applied: add a new one instead.
- **Request IDs**: the web proxy (`web/proxy.ts`) gives every request a fresh `x-request-id`, and the BFF forwards it to the API. The API reuses it if it is well formed, or generates one. Both apps echo it in the response. Every log line must carry it: use `req.log` in the API (never `app.log` or `console` inside a request) and `log` from `web/lib/log.server.ts` in the BFF (never `console`).
- **Health**: `/healthz` (liveness) must never touch dependencies. `/readyz` checks every dependency (SQLite, Postgres, Redis) and returns 503 if any is down. When adding a dependency, add a readiness check for it in `server.ts`. Responses show only ok/error per check: details go to the logs.
- **Local services bind to 127.0.0.1**, including ports in `docker-compose.yml`.
- **Secrets and data stay out of git**: `.env*` files are gitignored, except `.env.example`, which must never contain real secrets. Database files (`*.db`, `*.sqlite`, and their `-wal`/`-shm` files) are gitignored too. Never commit them.

## After each task

Run lint and type-check in each package you touched, and fix every error before finishing:

```bash
# everything, from the repo root
npm run lint && npm run typecheck

# or one package
npm run lint -w web && npm run typecheck -w web
npm run lint -w api && npm run typecheck -w api && npm test -w api
npm run lint -w @mini-payments/shared && npm run typecheck -w @mini-payments/shared
```

A change to `packages/shared` affects both apps, so type-check all three.

Then tell the user the exact commands to run the change and what they should see (e.g. which URL to open, expected output or UI state).

## Running locally

```bash
npm install                          # once, at the repo root
cp api/.env.example api/.env         # once
cp web/.env.example web/.env.local   # once
docker compose up -d                 # Postgres + Redis; wait until both are "healthy"
npm run migrate                      # apply pending Postgres migrations
npm run seed -w api                  # first run only: (re)creates the SQLite demo data

npm run dev:api   # API on http://localhost:4000 (check http://localhost:4000/readyz)
npm run dev:web   # web on http://localhost:3000
```

Roll back the last migration with `npm run migrate -- down`.
