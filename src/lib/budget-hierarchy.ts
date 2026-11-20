//
// Parent/child budget consistency (decision D10 in PLAN.md). A parent
// category's spending includes all its subcategories, so a subcategory budget
// above an ancestor's budget can never be reached before the ancestor is
// over. That's allowed; the budgets page only warns about it. Client-safe and
// pure, so it can be unit-tested and used by the page.

export interface BudgetLike {
  id: string;
  category_id: string;
  limit_minor: number;
}

export type HierarchyConflict<B extends BudgetLike = BudgetLike> =
  /** The limit is above the budget of an ancestor category. */
  | { kind: "above_ancestor"; budget: B }
  /** A descendant category has a budget above this limit. */
  | { kind: "below_descendant"; budget: B };

/**
 * Checks a budget limit against the budgets above and below its category.
 * Returns the nearest ancestor budget the limit exceeds, otherwise the
 * highest descendant budget that exceeds the limit, otherwise null.
 * `excludeBudgetId` is the budget being edited, so it isn't compared with
 * itself.
 */
export function findHierarchyConflict<B extends BudgetLike>({
  categoryId,
  limitMinor,
  budgets,
  parentOf,
  excludeBudgetId,
}: {
  categoryId: string;
  limitMinor: number;
  budgets: B[];
  parentOf: (categoryId: string) => string | null | undefined;
  excludeBudgetId?: string | null;
}): HierarchyConflict<B> | null {
  const others = budgets.filter((b) => b.id !== excludeBudgetId);
  const budgetByCategory = new Map(others.map((b) => [b.category_id, b]));

  const ancestorsOf = (id: string): string[] => {
    const ancestors: string[] = [];
    const seen = new Set<string>([id]);
    let cursor = parentOf(id);
    // `seen` guards against a cycle in parent_id, which has no FK or check.
    while (cursor && !seen.has(cursor)) {
      ancestors.push(cursor);
      seen.add(cursor);
      cursor = parentOf(cursor);
    }
    return ancestors;
  };

  for (const ancestorId of ancestorsOf(categoryId)) {
    const ancestorBudget = budgetByCategory.get(ancestorId);
    if (ancestorBudget && limitMinor > ancestorBudget.limit_minor) {
      return { kind: "above_ancestor", budget: ancestorBudget };
    }
  }

  const higherDescendants = others.filter(
    (b) =>
      b.limit_minor > limitMinor && ancestorsOf(b.category_id).includes(categoryId),
  );
  if (higherDescendants.length > 0) {
    const highest = higherDescendants.reduce((a, b) =>
      b.limit_minor > a.limit_minor ? b : a,
    );
    return { kind: "below_descendant", budget: highest };
  }
  return null;
}
