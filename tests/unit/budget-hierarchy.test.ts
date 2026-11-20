import { describe, expect, it } from "vitest";
import { findHierarchyConflict, type BudgetLike } from "#/lib/budget-hierarchy";

// Category tree: ent › dining › coffee, ent › subs, food › fruit
const parents: Record<string, string | null> = {
  ent: null,
  dining: "ent",
  coffee: "dining",
  subs: "ent",
  food: null,
  fruit: "food",
};
const parentOf = (id: string) => parents[id];

const budget = (category_id: string, limit_minor: number): BudgetLike => ({
  id: `b-${category_id}`,
  category_id,
  limit_minor,
});

const check = (
  categoryId: string,
  limitMinor: number,
  budgets: BudgetLike[],
  excludeBudgetId?: string,
) =>
  findHierarchyConflict({ categoryId, limitMinor, budgets, parentOf, excludeBudgetId });

describe("findHierarchyConflict", () => {
  it("is null without related budgets or when the child is within the parent", () => {
    expect(check("fruit", 50000, [])).toBeNull();
    expect(check("fruit", 30000, [budget("food", 40000)])).toBeNull();
    expect(check("fruit", 40000, [budget("food", 40000)])).toBeNull();
    // Unrelated categories never conflict.
    expect(check("subs", 99999, [budget("food", 100)])).toBeNull();
  });

  it("flags a child above its parent's budget", () => {
    expect(check("fruit", 600000, [budget("food", 40000)])).toEqual({
      kind: "above_ancestor",
      budget: budget("food", 40000),
    });
  });

  it("looks past parents without a budget, at any depth", () => {
    expect(check("coffee", 30000, [budget("ent", 25000)])).toMatchObject({
      kind: "above_ancestor",
      budget: { category_id: "ent" },
    });
  });

  it("reports the nearest ancestor the limit exceeds", () => {
    const budgets = [budget("ent", 20000), budget("dining", 10000)];
    expect(check("coffee", 15000, budgets)).toMatchObject({
      budget: { category_id: "dining" },
    });
    expect(check("coffee", 25000, budgets)).toMatchObject({
      budget: { category_id: "dining" },
    });
    // Within dining's 100, but dining's own budget is within ent's 200.
    expect(check("coffee", 5000, budgets)).toBeNull();
  });

  it("flags a parent lowered below a descendant's budget, naming the highest", () => {
    const budgets = [budget("coffee", 8000), budget("subs", 12000)];
    expect(check("ent", 10000, budgets)).toEqual({
      kind: "below_descendant",
      budget: budget("subs", 12000),
    });
    expect(check("ent", 12000, budgets)).toBeNull();
  });

  it("ignores the budget being edited", () => {
    const own = budget("fruit", 50000);
    expect(check("fruit", 70000, [own], own.id)).toBeNull();
  });

  it("stops on a cycle in the category tree", () => {
    const cyclic = (id: string) => ({ a: "b", b: "a" })[id as "a" | "b"];
    expect(
      findHierarchyConflict({
        categoryId: "a",
        limitMinor: 100,
        budgets: [budget("b", 50)],
        parentOf: cyclic,
      }),
    ).toMatchObject({ kind: "above_ancestor" });
  });
});
