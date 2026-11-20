import { m } from "#/paraglide/messages";
import { cn } from "#/lib/utils";
import {
  budgetPercent,
  budgetState,
  type BudgetProgress,
  type BudgetState,
} from "#/lib/budget-progress";

export const BUDGET_STATE_COLOR: Record<BudgetState, string> = {
  under: "bg-emerald-500",
  near: "bg-amber-500",
  over: "bg-destructive",
};

/** A thin progress bar for a budget: green, amber from 80%, red when over. */
export function BudgetProgressBar({
  budget,
  className,
  "data-testid": testId,
}: {
  budget: BudgetProgress;
  className?: string;
  "data-testid"?: string;
}) {
  const percent = budgetPercent(budget);
  return (
    <div
      className={cn("h-1.5 overflow-hidden rounded-full bg-muted", className)}
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.min(percent, 100)}
      aria-label={m.budget_progress_label({ percent })}
      data-testid={testId}
    >
      <div
        className={cn("h-full rounded-full", BUDGET_STATE_COLOR[budgetState(budget)])}
        style={{ width: `${Math.min(percent, 100)}%` }}
      />
    </div>
  );
}
