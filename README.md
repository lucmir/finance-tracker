# Finance Tracker

A personal finance tracker: accounts, nested categories, transactions, bank
CSV import with auto-categorization rules, AI receipt scanning, spending
analytics, and Free/Pro plans.

Built with TanStack Start, Drizzle (Postgres via embedded PGlite), TanStack
Query, Tailwind/shadcn UI and Paraglide i18n.

## Features

- **Dashboard:** spending and income analytics by category and over time.
- **Accounts and categories:** multiple accounts, categories nested to any depth.
- **Transactions:** manual entry and editing.
- **Import:** CSV import (generic and bank-specific formats) with duplicate
  detection.
- **Categorization:** rules (with optional AI fallback) that categorize
  imported transactions and can be re-applied to existing ones.
- **Receipts:** scan a receipt image with an OpenAI-compatible model and save
  it as a transaction with line items.
- **Billing:** Free and Pro plans via Stripe.
- **Privacy:** data export and account deletion (GDPR).

## Getting started

Requirements: Node.js 22+ and pnpm 10 (`corepack enable` picks up the pinned
version). Use `pnpm`, not `npm`.

```bash
pnpm install
pnpm exec playwright install chromium   # for E2E tests
pnpm run dev                            # http://127.0.0.1:3000
```

No `.env` is needed for local development: the database is an embedded PGlite
instance under `./data/pg`. See `.env.example` for optional settings (set
`AI_FAKE=1` to run without an AI provider).

## Scripts

| Command | What it does |
| --- | --- |
| `pnpm run dev` | Dev server on http://127.0.0.1:3000 |
| `pnpm run build` / `pnpm run start` | Production build and server |
| `pnpm run check` | Typecheck, lint, unit tests and E2E tests |
| `pnpm run test` / `pnpm run test:e2e` | Unit tests (Vitest) / E2E tests (Playwright) |
| `pnpm run db:generate` | Generate a Drizzle migration from `src/db/schema.ts` |
| `pnpm run i18n:compile` | Compile Paraglide messages from `messages/` |

## Project layout

- `src/routes/`: pages and API routes (TanStack Router, file-based).
- `src/server/`: `*.functions.ts` server functions called from routes, and
  `*.server.ts` server-only logic.
- `src/db/`: Drizzle schema and migrations runner; migrations live in `drizzle/`.
- `src/components/`: shared UI (shadcn-based).
- `messages/`: UI strings (Paraglide).
- `tests/`: unit tests; `tests/e2e/`: Playwright tests.

Coding conventions are in [CLAUDE.md](CLAUDE.md) (identical to
[AGENTS.md](AGENTS.md)).
