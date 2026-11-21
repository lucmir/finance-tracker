//
// How a budget's progress is classified and ordered. Shared by the Budgets
// page and the dashboard card so they always agree. Pure and client-safe.

import { getLocale } from "#/paraglide/runtime";

/** Share of the limit at which a budget is shown as close to it. */
export const NEAR_LIMIT_RATIO = 0.8;

export type BudgetState = "under" | "near" | "over";

export interface BudgetProgress {
  spent_minor: number;
  limit_minor: number;
  /** spent > limit (decision D5); computed by the server. */
  over: boolean;
}

export function budgetState(budget: BudgetProgress): BudgetState {
  if (budget.over) return "over";
  return budget.spent_minor >= budget.limit_minor * NEAR_LIMIT_RATIO
    ? "near"
    : "under";
}

/** Share of the limit spent, as a whole percentage (can exceed 100). */
export function budgetPercent(budget: BudgetProgress): number {
  return Math.round((budget.spent_minor * 100) / budget.limit_minor);
}

/** Over-budget first, then by share of the limit used, highest first. */
export function sortByUrgency<B extends BudgetProgress>(budgets: B[]): B[] {
  const ratio = (b: B) => b.spent_minor / b.limit_minor;
  return [...budgets].sort(
    (a, b) => Number(b.over) - Number(a.over) || ratio(b) - ratio(a),
  );
}

/** How many budgets are in each state. */
export function countByState(
  budgets: BudgetProgress[],
): Record<BudgetState, number> {
  const counts: Record<BudgetState, number> = { over: 0, near: 0, under: 0 };
  for (const b of budgets) counts[budgetState(b)]++;
  return counts;
}

/** "2026-11" → "November 2026" in the current locale (the month is UTC, D3). */
export function formatBudgetMonth(month: string): string {
  return new Intl.DateTimeFormat(getLocale(), {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(`${month}-01T00:00:00Z`));
}
