import { and, eq, inArray } from "drizzle-orm";
import { db, schema } from "#/db";

//
// Server-only budget logic. Imported by budgets.functions.ts handlers and by
// other server modules (category deletion, compliance); never by routes.

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
