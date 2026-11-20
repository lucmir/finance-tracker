import bcrypt from "bcryptjs";
import { and, eq } from "drizzle-orm";
import { db, schema } from "#/db";
import { hardDeleteUser } from "#/server/compliance.server";
import { seed, seedAccount, seedDefaultRules } from "#/server/seed";

//
// Demo data for local manual testing: one dedicated, email-verified user with
// the default categories, two accounts, and about three months of
// transactions dated relative to `now` (UTC), so the data always covers the
// current month. Run via `pnpm run seed:demo` (see scripts/seed-demo.ts).
// `reset` deletes the demo user through the GDPR hard-delete path first, so
// every table that path covers is cleaned up too. No other user is touched.

export const DEMO_EMAIL = "demo@example.com";
export const DEMO_USERNAME = "demo";
export const DEMO_PASSWORD = "demo-password";

/** Third-level category, so rollups over any depth can be exercised. */
const COFFEE_PATH = ["Entertainment", "Dining Out", "Coffee"];

type AccountKey = "main" | "card";

interface TemplateTx {
  day: number;
  /** Category path from the top level, or null for uncategorized. */
  path: string[] | null;
  amountMinor: number;
  description: string;
  account: AccountKey;
  /** Fixed amounts (salary, rent) don't vary from month to month. */
  fixed?: boolean;
}

// One month of activity. Negative amounts are expenses, positive are income.
const MONTH_TEMPLATE: TemplateTx[] = [
  { day: 1, path: null, amountMinor: 850000, description: "Salary", account: "main", fixed: true },
  { day: 1, path: ["Housing", "Rent / Mortgage"], amountMinor: -250000, description: "Rent", account: "main", fixed: true },
  { day: 3, path: COFFEE_PATH, amountMinor: -1600, description: "Coffee shop", account: "card" },
  { day: 4, path: ["Groceries", "Vegetables"], amountMinor: -8590, description: "Biedronka", account: "card" },
  { day: 6, path: ["Transport", "Fuel"], amountMinor: -22000, description: "Orlen", account: "card" },
  { day: 8, path: ["Groceries", "Dairy & Eggs"], amountMinor: -6350, description: "Lidl", account: "card" },
  { day: 10, path: ["Housing", "Utilities"], amountMinor: -31000, description: "Electricity bill", account: "main" },
  { day: 12, path: ["Entertainment", "Dining Out"], amountMinor: -12800, description: "Pizzeria", account: "card" },
  { day: 14, path: ["Groceries", "Meat & Fish"], amountMinor: -12720, description: "Biedronka", account: "card" },
  { day: 15, path: ["Entertainment", "Subscriptions"], amountMinor: -4300, description: "Streaming subscription", account: "card" },
  { day: 17, path: ["Shopping", "Clothing"], amountMinor: -39900, description: "Clothing store", account: "card" },
  { day: 19, path: null, amountMinor: -4500, description: "Unknown merchant", account: "card" },
  { day: 20, path: ["Groceries", "Snacks & Sweets"], amountMinor: -3890, description: "Żabka", account: "card" },
  { day: 22, path: ["Health", "Pharmacy"], amountMinor: -3450, description: "Pharmacy", account: "card" },
  { day: 24, path: COFFEE_PATH, amountMinor: -1450, description: "Coffee shop", account: "card" },
  { day: 26, path: ["Groceries", "Fruits"], amountMinor: -5120, description: "Lidl", account: "card" },
  { day: 28, path: ["Entertainment", "Dining Out"], amountMinor: -8600, description: "Sushi bar", account: "card" },
];

// Sample budgets, chosen against the current month's template amounts so the
// Budgets page shows all three states: Groceries near its limit (~367 of
// 400), Entertainment over (~288 of 250, including the third-level Coffee),
// Transport well under (220 of 500). Three is also the Free plan's limit.
const DEMO_BUDGETS: { path: string[]; limitMinor: number }[] = [
  { path: ["Groceries"], limitMinor: 40000 },
  { path: ["Entertainment"], limitMinor: 25000 },
  { path: ["Transport"], limitMinor: 50000 },
];

// Month-to-month variation for the dashboard charts, oldest month first.
const MONTH_FACTORS = [0.9, 1.1, 1.0];

export interface DemoSeedResult {
  userId: string;
  email: string;
  password: string;
  categories: number;
  accounts: number;
  transactions: number;
  budgets: number;
  /** First and last transaction dates (YYYY-MM-DD). */
  dateRange: [string, string];
}

export class DemoUserExistsError extends Error {
  constructor() {
    super(`Demo user ${DEMO_EMAIL} already exists. Run with --reset to recreate it.`);
  }
}

const pad = (n: number) => String(n).padStart(2, "0");
const toDate = (year: number, month0: number, day: number) =>
  `${year}-${pad(month0 + 1)}-${pad(day)}`;

export async function seedDemo(
  options: { reset?: boolean; now?: Date } = {},
): Promise<DemoSeedResult> {
  const now = options.now ?? new Date();

  const existing = await db
    .select({ id: schema.users.id })
    .from(schema.users)
    .where(eq(schema.users.email, DEMO_EMAIL))
    .limit(1);
  if (existing.length > 0) {
    if (!options.reset) throw new DemoUserExistsError();
    await hardDeleteUser(existing[0].id);
  }

  const userId = crypto.randomUUID();
  await db.insert(schema.users).values({
    id: userId,
    username: DEMO_USERNAME,
    email: DEMO_EMAIL,
    email_verified_at: now,
    password_hash: await bcrypt.hash(DEMO_PASSWORD, 12),
  });

  await seed(userId);
  await seedDefaultRules(userId);
  const accountIds: Record<AccountKey, string> = {
    main: await seedAccount(userId, "Main"),
    card: await seedAccount(userId, "Credit card"),
  };
  const categoryIdByPath = await addCoffeeAndMapPaths(userId);

  const rows: (typeof schema.transactions.$inferInsert)[] = [];
  const addTx = (date: string, tx: Omit<TemplateTx, "day">) => {
    const categoryId = tx.path ? categoryIdByPath.get(tx.path.join(" › ")) : null;
    if (categoryId === undefined) {
      throw new Error(`Demo seed: unknown category ${tx.path?.join(" › ")}`);
    }
    rows.push({
      id: crypto.randomUUID(),
      user_id: userId,
      account_id: accountIds[tx.account],
      date,
      amount_minor: tx.amountMinor,
      description: tx.description,
      category_id: categoryId,
      source: "manual",
    });
  };

  const year = now.getUTCFullYear();
  const month0 = now.getUTCMonth();
  const today = now.getUTCDate();
  for (const [index, monthsAgo] of [2, 1, 0].entries()) {
    const first = new Date(Date.UTC(year, month0 - monthsAgo, 1));
    const y = first.getUTCFullYear();
    const m = first.getUTCMonth();
    const daysInMonth = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
    // The current month only goes up to today: later entries are clamped to
    // today rather than dropped, so budgets show realistic totals even early
    // in the month, and nothing is ever dated in the future.
    const lastDay = monthsAgo === 0 ? today : daysInMonth;
    const factor = MONTH_FACTORS[index];

    for (const tx of MONTH_TEMPLATE) {
      const amountMinor = tx.fixed ? tx.amountMinor : Math.round(tx.amountMinor * factor);
      addTx(toDate(y, m, Math.min(tx.day, lastDay)), { ...tx, amountMinor });
    }

    if (monthsAgo === 1) {
      // Month-boundary check: last day of the previous month.
      addTx(toDate(y, m, daysInMonth), {
        path: ["Groceries", "Vegetables"],
        amountMinor: -5240,
        description: "Late-month shop",
        account: "card",
      });
    }
    if (monthsAgo === 0) {
      // A refund: positive amount in an expense category.
      addTx(toDate(y, m, Math.min(18, lastDay)), {
        path: ["Shopping", "Clothing"],
        amountMinor: 15000,
        description: "Clothing store refund",
        account: "card",
      });
    }
  }

  await db.insert(schema.transactions).values(rows);

  await db.insert(schema.budgets).values(
    DEMO_BUDGETS.map((b) => {
      const categoryId = categoryIdByPath.get(b.path.join(" › "));
      if (!categoryId) throw new Error(`Demo seed: unknown category ${b.path.join(" › ")}`);
      return {
        id: crypto.randomUUID(),
        user_id: userId,
        category_id: categoryId,
        limit_minor: b.limitMinor,
      };
    }),
  );

  const dates = rows.map((r) => r.date).sort();
  return {
    userId,
    email: DEMO_EMAIL,
    password: DEMO_PASSWORD,
    categories: categoryIdByPath.size,
    accounts: Object.keys(accountIds).length,
    transactions: rows.length,
    budgets: DEMO_BUDGETS.length,
    dateRange: [dates[0], dates[dates.length - 1]],
  };
}

/** Adds the third-level Coffee category and maps "A › B › C" paths to ids. */
async function addCoffeeAndMapPaths(userId: string): Promise<Map<string, string>> {
  const load = () =>
    db
      .select({
        id: schema.categories.id,
        name: schema.categories.name,
        parent_id: schema.categories.parent_id,
      })
      .from(schema.categories)
      .where(eq(schema.categories.user_id, userId));

  const [diningOut] = await db
    .select({ id: schema.categories.id })
    .from(schema.categories)
    .where(and(eq(schema.categories.user_id, userId), eq(schema.categories.name, "Dining Out")))
    .limit(1);
  await db.insert(schema.categories).values({
    id: crypto.randomUUID(),
    user_id: userId,
    name: COFFEE_PATH[2],
    parent_id: diningOut.id,
    color: "#6D4C41",
    sort_order: 0,
  });

  const categories = await load();
  const byId = new Map(categories.map((c) => [c.id, c]));
  const pathOf = (id: string): string => {
    const c = byId.get(id)!;
    return c.parent_id ? `${pathOf(c.parent_id)} › ${c.name}` : c.name;
  };
  return new Map(categories.map((c) => [pathOf(c.id), c.id]));
}
