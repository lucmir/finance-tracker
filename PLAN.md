# Monthly category budgets: plan

Source: [TASK.md](TASK.md). Each task below has an ID; PRs reference the IDs
they deliver (e.g. `Delivers: T2, T5`).

## Tasks

| ID | Task | Done when |
| --- | --- | --- |
| T1 | Budgets page in the main navigation | A "Budgets" entry in the sidebar opens `/budgets` for signed-in users. |
| T2 | Manage budgets | A user can add a budget (category + monthly limit), change its limit, and remove it. |
| T3 | Budget progress | Each budget shows the limit, spent this month, what's left, and a clear over-budget state. |
| T4 | Subcategory rollup | A budget on a parent category includes spending in all its subcategories, at any depth. |
| T5 | Only spending counts | Expenses (negative amounts) count; income and refunds don't reduce the spent amount. |
| T6 | Monthly reset | "Spent" covers the current calendar month only; a new month starts from zero. |
| T7 | Over-budget email | The user gets an email when a budget goes over its limit, at most once per budget per month. |
| T8 | Plan limits | Free plan: up to 3 budgets. Pro: unlimited. Hitting the limit prompts an upgrade. |
| T9 | Compliance | Budgets (and alert records) are included in the GDPR export and removed on account deletion. |
| T10 | No regressions | Existing features keep working (including deleting a category that has a budget); `pnpm run check` passes. |
| T11 | README | The README briefly describes the architecture and the features, with a focus on budgets, and includes screenshots. |

## Design decisions

All decisions confirmed on 2026-11-20. The chosen option is marked
*Decided*; the others are kept for context.

| ID | Decision |
| --- | --- |
| D1 | Function middleware on the 9 spending server functions, an explicit check at the end of the `confirmImport` stream, and the hourly sweep as a backstop |
| D2 | Count spending by the transaction's category (not receipt item categories) |
| D3 | "This month" is the UTC calendar month |
| D4 | Deleting a category deletes budgets on it and its descendants |
| D5 | Over budget means spent > limit; creating a budget or lowering its limit can trigger the email |
| D6 | Emails go to verified addresses only; skipped users aren't marked as alerted |
| D7 | One budget per category; parent and child budgets count independently; positive limit in minor units, single currency |
| D8 | After a downgrade, existing budgets keep working; creating new ones is blocked until under the limit |
| D9 | Fix scanned receipts being stored as income, in its own PR before the budget calculation |

**D1. When the over-budget check runs (T7).** Spending changes in 9 server
functions: `createTransaction`, `updateTransaction`, `deleteTransaction`,
`saveReceiptAndLink`, `deleteCategory`, `applyRuleToExisting`,
`reCategorizeTransactions`, `confirmImport`, `deleteImportBatch`. In every
option the check is one idempotent `checkBudgetAlerts(userId)`; the options
differ in what calls it.
- (a) *Decided:* a function middleware (`budgetAlertsAfter`) attached to
  those server functions with `.middleware([...])`. It runs after the handler
  on every return path, takes the user id from the request context that
  `requireUserId()` already sets, and logs (never throws) on failure.
  Exception: `confirmImport` streams (async generator), so its middleware
  would run before rows are inserted; it calls the check explicitly at the
  end of the stream. Plus the hourly sweep as a backstop.
- (b) Explicit call inside each handler: same coverage, but handlers have
  several return points and the call mixes into business logic.
- (c) Global function middleware in `start.ts`: no per-function wiring and
  covers future write paths, but runs on every mutation (login, settings…),
  is invisible at the call site, and has the same streaming gap.
- (d) Sweep only: no changes to existing code, but up to an hour's delay.
- (e) Postgres trigger marks users "dirty", drained after the request or by
  the sweep: catches any write, but adds a queue table and raw SQL triggers.

**D2. Receipt items with their own category (T3, T4).** When a scanned
receipt creates a transaction, the transaction gets the receipt's top-level
category and each item gets a subcategory of it (the item picker only offers
children of that category). When a receipt is linked to an existing
transaction, the transaction keeps its own category and the items may sit
under a different one.
- (a) *Decided:* count by the transaction's category only. Budgets on
  top-level categories are exact for scanned receipts (via T4); "spent" matches
  the transactions list and the dashboard's "top categories". Known
  limitation: a budget on a subcategory (e.g. Food › Snacks) doesn't see
  snack items inside a receipt filed under Food, and a linked receipt's items
  don't move spending to another category.
- (b) Count by item category for transactions with a receipt, sending any
  remainder (transaction total − items sum) to the transaction's category.
  Precise, but needs rules for remainders, discounts and AI misreads, and
  "spent" would no longer match the dashboard or transactions list.

**D3. Which time zone defines "this month" (T6, T7).**
- (a) *Decided:* UTC calendar month on the server, like the AI scan quota
  (`monthStart()` in `ai-usage.server.ts`). Transaction dates are calendar
  dates, so this only matters on the first/last day of the month.
- (b) The user's local month, which needs a stored per-user time zone (none exists).

**D4. Deleting a category that has a budget (T10).**
- (a) *Decided:* delete budgets on the deleted category and its
  descendants, in the same handler that already cleans up rules.
- (b) Move the budget to the reassignment target (conflicts if the target
  already has one).

**D5. What "over budget" means (T3, T7).** *Decided:* spent > limit
(exactly at the limit is not over). The email fires whenever a check finds a
budget over and no alert was sent for it this month, including right after
creating a budget or lowering its limit.

**D6. Who gets the email (T7).** *Decided:* only users with a verified
email; others are skipped and not marked as alerted, so they can still get it
later in the month after verifying.

**D7. Budget scope rules (T2).** *Decided:* one budget per category;
budgets on both a parent and its child are allowed and count independently;
limit is a positive amount stored in minor units, in the app's single display
currency (amounts across accounts are summed without conversion, as the
dashboard does).

**D8. Downgrade from Pro with more than 3 budgets (T8).** *Decided:* keep
all budgets working (progress and emails), block creating new ones until under
the limit. This matches how accounts behave.

**D9. Scanned receipts are stored as income (existing bug, affects T5).**
`saveReceiptAndLink` stores a new receipt transaction with
`amount_minor = +total` (`receipts.functions.ts:524`; the scan page sends the
positive receipt total, while its own "find matching transaction" lookup
searches for `-total`). Every other part of the app treats positive amounts as
income, so scanned purchases show as income on the dashboard and would never
count toward a budget.
- (a) *Decided:* fix in its own PR before the budget calculation: store
  `-abs(total)` server-side, plus a test. Existing rows with `source =
  'receipt'` and a positive amount can be flipped by a one-off data migration.
- (b) Leave it and document that scanned receipts don't count.

## Out of scope

- Per-user time zones and currency conversion.
- Counting receipt items by their own category (D2 option b).

## Follow-ups found along the way

Existing issues, not caused by this work. Each would be its own PR if picked up.

| ID | Issue | Found in |
| --- | --- | --- |
| F1 | Two flaky E2E tests: `categories.spec.ts:59` (strict-mode race on `getByText("Edit Me")`) and `import-dedup.spec.ts:27` (file-chooser timeout). Passed on rerun. Fixed in #7, together with a third race in the import specs. | S9 CI |
| F2 | Scan Receipt can't create a new transaction once a match is suggested: any transaction on the same date counts as a match, editing the date doesn't refresh it, and the "Refresh match" message exists without a button. | S1 manual test |
| F3 | The demo seed moves later-day entries of the current month to today, so today is crowded and scanning a receipt as the demo user always links (because of F2). | S1 manual test |
| F4 | The CSP (`style-src 'self' 'unsafe-inline'`) blocks the Google Fonts stylesheet, so every page logs a console error and falls back to system fonts. | S1 manual test |
| F5 | The Categories page hardcodes some English text instead of Paraglide messages: the page title and subtitle, "Choose how to handle them:" in the delete dialog, and the server's error strings. | S3 |
| F6 | The category dialog only offers top-level categories as parents, so the UI can't create a third level, and editing a third-level category (e.g. the demo's Coffee) can't show its real parent. The data model and budgets support any depth. | S3 |

## Implementation plan

### How the work is split

One PR per step. Each step is merged before the next one branches from
`main` (no stacked PRs), and every merge leaves `main` shippable: user data
never exists without its compliance handling, and `pnpm run check` passes.
Rows are in execution order; step IDs never change once assigned.

| Step | PR title | Delivers | Depends on | Status |
| --- | --- | --- | --- | --- |
| S0 | `docs: add budgets plan` | — | — | done (#2) |
| S9 | `chore(seed): add demo user seed for local testing` | — | S0 | done (#3) |
| S1 | `fix(receipts): store scanned receipts as expenses` | D9, T5 | S0 | done (#4) |
| S2 | `feat(budgets): add budgets data model` | T9, T10 (D4) | S0 | done (#5) |
| S3 | `feat(budgets): add budgets page` | T1, T2 | S2 | in review |
| S4 | `feat(budgets): show monthly progress` | T3, T4, T5, T6 | S1, S3 | todo |
| S5 | `feat(budgets): email when a budget is exceeded` | T7 | S4 | todo |
| S6 | `feat(billing): limit budgets on the free plan` | T8 | S3 | todo |
| S7 | `docs: document architecture and budgets in the README` | T10, T11 | S5, S6 | todo |
| S8 | `fix(transactions): show dates without a time zone shift` (optional) | — | — | todo |

Conventions for every PR:
- Branch `<type>/<step>-<short-name>` (e.g. `feat/s3-budgets-page`); the PR
  description starts with `Plan: S3 · Delivers: T1, T2`.
- Opened and monitored with the pr-workflow skill; `pnpm run check` passes
  locally and in CI.
- User-facing text goes through Paraglide (`messages/en.json`); every
  user-facing change has Playwright coverage (happy path, errors, edge cases).
- The PR's "How to test" section repeats the manual steps below.

Manual testing setups:
- **Dev:** `AI_FAKE=1 pnpm run dev` → http://127.0.0.1:3000. Uses your
  persistent database in `./data/pg`; emails are printed in the terminal.
  Log in as the demo user (`demo@example.com` / `demo-password`), created
  with `pnpm run seed:demo` (`--reset` to rebuild it) while the dev server is
  stopped.
- **Test mode:** `TEST_MODE=1 AI_FAKE=1 pnpm run dev`. In-memory database
  (create a user at `/setup`), emails readable at `/test-emails`, plan switch
  via `fetch('/test-set-plan?plan=pro', { method: 'POST' })` in the browser
  console.
- Stop any dev server before running `pnpm run check`: E2E needs port 3000.

### S0. Commit the plan
This file. Reviewed as text; nothing to test.

### S9. Demo seed for local testing
- `pnpm run seed:demo [--reset]` creates a dedicated, email-verified demo
  user with the default categories plus a third-level one (Entertainment ›
  Dining Out › Coffee), two accounts, and about three months of transactions
  dated relative to today (UTC): income, a refund, uncategorized expenses,
  and rows on the last day of the previous month and the first of this one.
  `--reset` deletes the demo user through `hardDeleteUser` and rebuilds it;
  no other user is touched. Refuses to run while port 3000 is in use.
- Later steps extend it: S3 adds sample budgets, and from S4 the data gives
  one budget under, one close to, and one over its limit.
- Tests: unit tests for dates, month boundaries, the refund, the third-level
  category, and reset only replacing the demo user.
- Manual: stop the dev server → `pnpm run seed:demo` prints the login and
  counts (running it again without `--reset` refuses) → start the dev server
  and log in as the demo user. Dashboard shows three months; Transactions has
  this month's refund and uncategorized rows; Categories shows Coffee under
  Dining Out.

### S1. Store scanned receipts as expenses (D9)
- `saveReceiptAndLink` stores a new receipt transaction as `-abs(total)`.
- Data migration (custom Drizzle migration): flip existing rows with
  `source = 'receipt'` and a positive amount.
- Tests: E2E in `receipts-scanning.spec.ts` asserts the saved transaction is
  an expense; migration covered by the existing migration test.
- Manual (Dev): Scan Receipt → upload
  `tests/e2e/fixtures/images/receipt-test.png` → save as a new transaction.
  Transactions shows it as an expense (−36.99), and the dashboard's expenses
  go up by that amount. A receipt saved before this change shows as negative
  after the server restarts.

### S2. Budgets data model (T9, D4, D7)
- Schema: `budgets` (`id`, `user_id`, `category_id`, `limit_minor` with a
  `> 0` check, timestamps; unique `(user_id, category_id)`) and
  `budget_alerts` (`id`, `budget_id`, `user_id`, `month` as `YYYY-MM`,
  `sent_at`; unique `(budget_id, month)`). Migration via `pnpm db:generate`.
- `budgets.server.ts` starts with `deleteBudgetsForCategories(userId, ids)`;
  `deleteCategory` calls it for the category and its descendants (D4).
- Compliance: budgets in the export (`export.json`, each with its `alerts`
  nested like receipt items, plus `budgets.csv`) and deleted in
  `hardDeleteUser`; the privacy policy's "What we store" lists budgets and
  alert records. `budget` added to `OWNED_TABLES`.
- Tests: unit tests for export, hard delete, category cleanup, and the schema
  constraints (one budget per category, positive limit, one alert per budget
  per month).
- Manual (Dev): restart on your existing database; the server boots (migration
  applied) and existing pages work. Settings → export data → `export.json`
  contains `"budgets": []` and the zip has a `budgets.csv` with only a header.
  Privacy page mentions budgets. Deleting a category still works. (No UI to
  create budgets yet; that comes in S3.)

### S3. Budgets page: add, change, remove (T1, T2, D7)
- Server functions in `budgets.functions.ts` (`getBudgets`, `createBudget`,
  `updateBudget`, `deleteBudget`): `requireUserId()`, Zod input, category
  ownership check, one budget per category, positive limit.
- Route `src/routes/_authed/budgets.tsx` with TanStack Query; "Budgets" in the
  sidebar. List (category with color, limit), empty state, add dialog
  (category picker showing the tree, limit input), edit-limit dialog, delete
  confirmation. Progress columns come in S4.
- Tests: E2E for navigation, add/edit/delete, validation (empty, zero,
  negative limit; duplicate category), empty state, and deleting a category
  removing its budget.
- Manual (Dev): sidebar → Budgets shows the empty state. Add Food with 500 →
  row appears. Edit to 600 → updated. Add Food again → "already has a budget"
  error. Delete → row gone. Add a budget on a subcategory, delete that
  category on Categories → its budget is gone.

### S4. Monthly progress (T3–T6, D2, D3, D5)
- `getBudgetProgress(userId, now)` in `budgets.server.ts`: one query with a
  recursive CTE over each budget's category and all its descendants; sums
  expenses only (`amount_minor < 0`) by transaction category, dated within
  the current UTC month. Returns limit, spent, left (may be negative), over
  (spent > limit).
- Page shows spent, left, a progress bar, the month, and a clear over-budget
  state ("Over by X", red).
- Tests: unit tests as the spec: income and refunds ignored, nested
  subcategories counted, sibling categories and other users excluded,
  previous/next month excluded, first/last day of the month included,
  exactly-at-limit is not over, scanned receipts counted. E2E for the page
  states.
- Manual (Dev): budget on Food = 100. Add −30 in a Food subcategory dated
  today → spent 30, left 70. Add +20 income in Food → still 30. Add −80 → spent
  110, "Over by 10". Add −50 dated last month → unchanged.

### S5. Over-budget email (T7, D1, D5, D6)
- `checkBudgetAlerts(userId, now)`: for each budget over its limit with no
  alert this month, and only if the user's email is verified, insert the
  alert row (`ON CONFLICT DO NOTHING`, so concurrent checks send at most once)
  and then send the email; if sending fails, the row is removed so a later
  check retries.
- `budgetAlertsAfter` function middleware on the 9 spending server functions
  plus `createBudget`/`updateBudget`; explicit call at the end of the
  `confirmImport` stream; a budget pass in the hourly sweep (also run by
  `/test-run-sweep`). Failures are logged, never shown to the user.
- Email text in Paraglide, with category, limit, spent, and a link to
  `/budgets`. TanStack middleware docs checked before implementing.
- Tests: unit: one email per budget per month, a new month sends again,
  unverified/no email sends nothing and isn't marked, not-over and
  at-limit send nothing. E2E via `/test-emails?to=`: going over sends one
  email, a second expense doesn't send another, a CSV import that goes over
  sends one, creating a budget below current spending sends one.
- Manual (Dev, with a verified email; the verification link is printed in the
  terminal): budget on Food = 50, add −60 → the terminal prints
  `[email] To: … Subject: …` once. Add another −10 → no second email.

### S6. Free plan limit (T8, D8)
- `BILLING_FREE_MAX_BUDGETS` in `env.ts` (default 3), `maxBudgets` in
  entitlements, `checkBudgetLimit` like `checkAccountLimit`; `createBudget`
  returns `{ error, code: "budget_limit_reached", limit }`.
- Budgets page shows "X of 3 budgets" on Free and replaces Add with an upgrade
  link to Billing at the limit; the Billing page lists budget usage.
- Tests: unit (free limit, Pro unlimited, downgrade keeps existing budgets,
  env validation); E2E (4th budget blocked on Free, allowed after
  `/test-set-plan?plan=pro`, all kept and Add blocked after `?plan=free`).
- Manual (Test mode): add 3 budgets → the 4th is blocked with an upgrade link.
  Switch to Pro in the console, reload → the 4th can be added. Switch back to
  Free → all 4 remain, Add is blocked, and Billing shows 4 of 3.

### S7. README: architecture, features, screenshots (T11)
- **Architecture (brief):** stack; folder layout; how a feature flows from
  the schema through `*.server.ts` and `*.functions.ts` to a route with
  TanStack Query; where auth, plan limits, email and the hourly sweep plug in.
- **Features:** short overview of the existing ones, then a Budgets section:
  what a budget counts (subcategories, expenses only, UTC calendar month),
  the over-budget email, the Free/Pro limit, and known limitations (receipt
  items counted by the transaction's category, single currency).
- **Screenshots** of the demo user (`pnpm run seed:demo --reset`, so they
  show demo data only), captured with playwright-cli and stored in
  `docs/screenshots/`: Budgets page with under / near / over budgets, the
  add-budget dialog, the Free plan limit with the upgrade prompt, and the
  dashboard. The over-budget email is shown as a text sample.
- Plan statuses updated.
- Manual: read the README on the PR's GitHub page (images render); full demo
  run-through of S3–S6 on a freshly seeded dev server.

### S8. Transactions date display (optional)
- `formatTxDate` in `transactions.tsx` parses calendar dates as UTC, so dates
  show a day early west of UTC, and one E2E test fails locally in UTC−3.
  Unrelated to budgets, but it keeps local `pnpm run check` red, so it's
  worth doing early.
- Manual (Dev, machine in a UTC− time zone): add a transaction dated today →
  the list shows today's date, not yesterday's.
