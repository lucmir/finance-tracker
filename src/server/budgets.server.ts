import { and, eq, inArray, sql } from "drizzle-orm";
import { db, schema } from "#/db";
import { checkBudgetLimit } from "#/server/billing.server";
import { ownedEntityExists } from "#/server/ownership.server";

//
// Server-only budget logic. Imported by budgets.functions.ts handlers and by
// other server modules (category deletion, compliance); never by routes.
// Expected failures are returned as `{ error, code }` (the UI maps `code` to
// a translated message), never thrown.

export type BudgetErrorCode =
  | "category_not_found"
  | "budget_exists"
  | "budget_not_found"
  | "budget_limit_reached";

export type BudgetError = {
  error: string;
  code: BudgetErrorCode;
  /** The plan's budget limit, for `budget_limit_reached`. */
  limit?: number;
};

const ERROR_MESSAGES: Record<Exclude<BudgetErrorCode, "budget_limit_reached">, string> = {
  category_not_found: "Category does not exist",
  budget_exists: "This category already has a budget",
  budget_not_found: "Budget not found",
};

const fail = (code: keyof typeof ERROR_MESSAGES): BudgetError => ({
  error: ERROR_MESSAGES[code],
  code,
});

export interface BudgetRow {
  id: string;
  category_id: string;
  category_name: string;
  category_color: string;
  /** Names from the top-level category down to this one. */
  category_path: string[];
  limit_minor: number;
  /** Spending this month in the category and all its subcategories. */
  spent_minor: number;
  /** limit − spent; negative when over. */
  left_minor: number;
  /** Over budget means spent > limit; exactly at the limit is not over (D5). */
  over: boolean;
  created_at: Date;
  updated_at: Date;
}

export interface BudgetMonth {
  /** "YYYY-MM" */
  month: string;
  /** First day of the month, "YYYY-MM-DD" (inclusive). */
  start: string;
  /** First day of the next month, "YYYY-MM-DD" (exclusive). */
  end: string;
}

/**
 * The calendar month containing `now`, in UTC (decision D3), like the AI
 * scan quota. Transaction dates are calendar dates, so this only matters on
 * the first and last day of a month.
 */
export function budgetMonth(now: Date): BudgetMonth {
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  return {
    month: iso(new Date(Date.UTC(y, m, 1))).slice(0, 7),
    start: iso(new Date(Date.UTC(y, m, 1))),
    end: iso(new Date(Date.UTC(y, m + 1, 1))),
  };
}

/**
 * Spending this month per budget, in minor units (positive). For each
 * budget: its category and every descendant (any depth, via a recursive CTE;
 * UNION dedups rows, so a cycle in parent_id can't loop forever), expenses
 * only (amount_minor < 0, so income and refunds never reduce it), counted by
 * the transaction's own category (decision D2), dated within the UTC month.
 * Budgets without spending are included with 0.
 */
export async function spentByBudget(
  userId: string,
  now: Date = new Date(),
): Promise<Map<string, number>> {
  const { start, end } = budgetMonth(now);
  const result = await db.execute(sql`
    WITH RECURSIVE budget_tree (budget_id, category_id) AS (
      SELECT b.id, b.category_id
      FROM ${schema.budgets} b
      WHERE b.user_id = ${userId}
      UNION
      SELECT bt.budget_id, c.id
      FROM budget_tree bt
      JOIN ${schema.categories} c
        ON c.parent_id = bt.category_id AND c.user_id = ${userId}
    )
    SELECT bt.budget_id, COALESCE(SUM(-t.amount_minor), 0)::bigint AS spent
    FROM budget_tree bt
    LEFT JOIN ${schema.transactions} t
      ON t.category_id = bt.category_id
      AND t.user_id = ${userId}
      AND t.amount_minor < 0
      AND t.date >= ${start}::date
      AND t.date < ${end}::date
    GROUP BY bt.budget_id
  `);
  const rows = result.rows as Array<{ budget_id: string; spent: string | number }>;
  return new Map(rows.map((r) => [r.budget_id, Number(r.spent)]));
}

/**
 * The user's budgets, with each category's full path and this month's
 * progress, ordered by path.
 */
export async function listBudgets(
  userId: string,
  now: Date = new Date(),
): Promise<BudgetRow[]> {
  const [budgets, categories, spent] = await Promise.all([
    db
      .select()
      .from(schema.budgets)
      .where(eq(schema.budgets.user_id, userId)),
    db
      .select({
        id: schema.categories.id,
        name: schema.categories.name,
        parent_id: schema.categories.parent_id,
        color: schema.categories.color,
      })
      .from(schema.categories)
      .where(eq(schema.categories.user_id, userId)),
    spentByBudget(userId, now),
  ]);

  const byId = new Map(categories.map((c) => [c.id, c]));
  const pathOf = (id: string): string[] => {
    const path: string[] = [];
    const seen = new Set<string>();
    let cursor: string | null = id;
    // `seen` guards against a cycle in parent_id, which has no FK or check.
    while (cursor && !seen.has(cursor)) {
      seen.add(cursor);
      const category = byId.get(cursor);
      if (!category) break;
      path.unshift(category.name);
      cursor = category.parent_id;
    }
    return path;
  };

  return budgets
    .map((b) => {
      const category = byId.get(b.category_id);
      const spentMinor = spent.get(b.id) ?? 0;
      return {
        id: b.id,
        category_id: b.category_id,
        category_name: category?.name ?? "",
        category_color: category?.color ?? "#6b7280",
        category_path: pathOf(b.category_id),
        limit_minor: b.limit_minor,
        spent_minor: spentMinor,
        left_minor: b.limit_minor - spentMinor,
        over: spentMinor > b.limit_minor,
        created_at: b.created_at,
        updated_at: b.updated_at,
      };
    })
    .sort((a, b) =>
      a.category_path.join("\u0000").localeCompare(b.category_path.join("\u0000")),
    );
}

/**
 * Creates a budget on one of the user's categories (one per category),
 * within the plan's budget limit (T8).
 */
export async function createBudget(
  userId: string,
  input: { categoryId: string; limitMinor: number },
): Promise<{ id: string } | BudgetError> {
  const limit = await checkBudgetLimit(userId);
  if (!limit.allowed) {
    return { error: limit.error, code: limit.code, limit: limit.limit };
  }
  if (!(await ownedEntityExists("category", userId, input.categoryId))) {
    return fail("category_not_found");
  }
  const existing = await db
    .select({ id: schema.budgets.id })
    .from(schema.budgets)
    .where(
      and(
        eq(schema.budgets.user_id, userId),
        eq(schema.budgets.category_id, input.categoryId),
      ),
    )
    .limit(1);
  if (existing.length > 0) return fail("budget_exists");

  const id = crypto.randomUUID();
  try {
    await db.insert(schema.budgets).values({
      id,
      user_id: userId,
      category_id: input.categoryId,
      limit_minor: input.limitMinor,
    });
  } catch (error) {
    // Two concurrent creates: the unique constraint decides.
    if (isUniqueViolation(error)) return fail("budget_exists");
    throw error;
  }
  return { id };
}

/** Changes a budget's monthly limit. The category can't be changed. */
export async function updateBudgetLimit(
  userId: string,
  input: { id: string; limitMinor: number },
): Promise<{ id: string } | BudgetError> {
  const updated = await db
    .update(schema.budgets)
    .set({ limit_minor: input.limitMinor, updated_at: new Date() })
    .where(
      and(eq(schema.budgets.id, input.id), eq(schema.budgets.user_id, userId)),
    )
    .returning({ id: schema.budgets.id });
  return updated.length > 0 ? { id: input.id } : fail("budget_not_found");
}

/** Removes a budget and its alert records. */
export async function deleteBudget(
  userId: string,
  id: string,
): Promise<{ id: string } | BudgetError> {
  if (!(await ownedEntityExists("budget", userId, id))) {
    return fail("budget_not_found");
  }
  await db
    .delete(schema.budget_alerts)
    .where(
      and(
        eq(schema.budget_alerts.budget_id, id),
        eq(schema.budget_alerts.user_id, userId),
      ),
    );
  await db
    .delete(schema.budgets)
    .where(and(eq(schema.budgets.id, id), eq(schema.budgets.user_id, userId)));
  return { id };
}

function isUniqueViolation(error: unknown): boolean {
  // node-postgres and PGlite both expose SQLSTATE as `code`; Drizzle may wrap
  // the driver error in `cause`.
  const code = (e: unknown) =>
    e && typeof e === "object" && "code" in e ? (e as { code: unknown }).code : undefined;
  return (
    code(error) === "23505" ||
    code((error as { cause?: unknown } | null)?.cause) === "23505"
  );
}

/**
 * Deletes the user's budgets on the given categories, with their alert
 * records. Called when categories are deleted: a budget only makes sense for
 * its own category, so it goes with it rather than moving to the
 * reassignment target (decision D4 in PLAN.md).
 */
export async function deleteBudgetsForCategories(
  userId: string,
  categoryIds: string[],
): Promise<number> {
  if (categoryIds.length === 0) return 0;
  const budgetIds = db
    .select({ id: schema.budgets.id })
    .from(schema.budgets)
    .where(
      and(
        eq(schema.budgets.user_id, userId),
        inArray(schema.budgets.category_id, categoryIds),
      ),
    );
  await db
    .delete(schema.budget_alerts)
    .where(inArray(schema.budget_alerts.budget_id, budgetIds));
  const deleted = await db
    .delete(schema.budgets)
    .where(
      and(
        eq(schema.budgets.user_id, userId),
        inArray(schema.budgets.category_id, categoryIds),
      ),
    )
    .returning({ id: schema.budgets.id });
  return deleted.length;
}
