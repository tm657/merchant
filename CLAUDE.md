# mini-payments

A mini merchant payments dashboard, built as interview practice.

## Layout

- `web/`: Next.js (App Router), TypeScript, Tailwind, TanStack Query, zod. Acts as a backend-for-frontend (BFF). Runs on port **3000**.
- `api/`: Node 20+ TypeScript service using Fastify, better-sqlite3, zod, and tsx. Runs on port **4000**.
- The web app reads the API address from `API_URL` in `web/.env.local` (e.g. `API_URL=http://localhost:4000`). Only server code reads it; never expose it to the browser.
- `web/` uses a newer Next.js with breaking changes. Read `web/AGENTS.md` and the docs in `web/node_modules/next/dist/docs/` before writing Next.js code.

## Rules

- **Money**: always an integer amount in minor units plus a currency code (e.g. `{ amount: 1999, currency: "EUR" }`). Never use floats for money, in storage, transport, or math. Format for display only at render time.
- **BFF boundary**: the browser never calls the API directly. Client code calls Next.js route handlers in `web/app/api/...`, and those call the API using `API_URL`.
- **State holds inputs only**: keep filters, sort, and cursor in state. Derive rows from those inputs (via the query). Never store sorted or filtered copies of data.
- **URL is the source of truth** for filters and sort, so views are shareable and survive reload.
- **Pagination is cursor-based**: no offset/page-number pagination.
- **Validate at boundaries with zod**: API request input, API responses parsed in the BFF, and BFF responses parsed in the client.
- **Database files are gitignored** (`*.db`, `*.sqlite`, and their `-wal`/`-shm` files). Never commit them.

## After each task

Run lint and type-check in each package you touched, and fix every error before finishing:

```bash
# web
cd web && npm run lint && npx tsc --noEmit

# api
cd api && npm run lint && npx tsc --noEmit
```

Then tell the user the exact commands to run the change and what they should see (e.g. which URL to open, expected output or UI state).

## Running locally

```bash
cd api && npm run dev   # API on http://localhost:4000
cd web && npm run dev   # web on http://localhost:3000
```
