import { and, eq, inArray } from "drizzle-orm";
import { db, schema } from "#/db";
import { ownedEntityExists } from "#/server/ownership.server";

//
// Server-only budget logic. Imported by budgets.functions.ts handlers and by
// other server modules (category deletion, compliance); never by routes.
// Expected failures are returned as `{ error, code }` (the UI maps `code` to
// a translated message), never thrown.

export type BudgetErrorCode =
  | "category_not_found"
  | "budget_exists"
  | "budget_not_found";

export type BudgetError = { error: string; code: BudgetErrorCode };

const ERROR_MESSAGES: Record<BudgetErrorCode, string> = {
  category_not_found: "Category does not exist",
  budget_exists: "This category already has a budget",
  budget_not_found: "Budget not found",
};

const fail = (code: BudgetErrorCode): BudgetError => ({
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
  created_at: Date;
  updated_at: Date;
}

/** The user's budgets, with each category's full path, ordered by path. */
export async function listBudgets(userId: string): Promise<BudgetRow[]> {
  const [budgets, categories] = await Promise.all([
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
      return {
        id: b.id,
        category_id: b.category_id,
        category_name: category?.name ?? "",
        category_color: category?.color ?? "#6b7280",
        category_path: pathOf(b.category_id),
        limit_minor: b.limit_minor,
        created_at: b.created_at,
        updated_at: b.updated_at,
      };
    })
    .sort((a, b) =>
      a.category_path.join("\u0000").localeCompare(b.category_path.join("\u0000")),
    );
}

/** Creates a budget on one of the user's categories (one per category). */
export async function createBudget(
  userId: string,
  input: { categoryId: string; limitMinor: number },
): Promise<{ id: string } | BudgetError> {
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
