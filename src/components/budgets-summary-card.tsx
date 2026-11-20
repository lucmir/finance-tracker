import { Link } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useQuery } from "@tanstack/react-query";
import { m } from "#/paraglide/messages";
import { formatMinor } from "#/lib/money";
import { cn } from "#/lib/utils";
import {
  budgetPercent,
  countByState,
  formatBudgetMonth,
  sortByUrgency,
  type BudgetState,
} from "#/lib/budget-progress";
import {
  BUDGET_STATE_COLOR,
  BudgetProgressBar,
} from "#/components/budget-progress-bar";
import { getBudgets } from "#/server/budgets.functions";

//
// Dashboard "Budgets this month" card (T12). Always the current UTC month
// and all accounts, independent of the dashboard's period and account
// filters: budgets are monthly and cross-account, and the title says so.
// Shows counts per state (not money totals: a parent budget already
// includes its subcategories' spending, so totals would double-count) and
// the most urgent budgets.

/** How many budgets the card lists before "+ N more". */
const MAX_LISTED = 4;

const money = (minor: number) => `${formatMinor(minor)} ${m.analytics_currency()}`;

const STATE_LABEL: Record<BudgetState, (n: number) => string> = {
  over: (n) => m.dashboard_budgets_over({ n }),
  near: (n) => m.dashboard_budgets_near({ n }),
  under: (n) => m.dashboard_budgets_on_track({ n }),
};

export function BudgetsSummaryCard() {
  const getBudgetsFn = useServerFn(getBudgets);
  // Same query as the Budgets page, so either page warms the other's cache.
  const { data } = useQuery({
    queryKey: ["budgets"],
    queryFn: () => getBudgetsFn(),
  });
  if (!data) {
    // Hold the section's place while loading, so the filters below it don't
    // jump when the budgets arrive.
    return (
      <section aria-labelledby="dashboard-budgets-title" className="space-y-3" aria-busy="true">
        <h2 id="dashboard-budgets-title" className="text-base font-semibold">
          {m.dashboard_budgets_title()}
        </h2>
        <div className="island-shell h-32 rounded-xl p-4 text-sm text-muted-foreground">
          {m.loading()}
        </div>
      </section>
    );
  }

  const budgets = sortByUrgency(data.budgets);
  const counts = countByState(budgets);
  const listed = budgets.slice(0, MAX_LISTED);
  const more = budgets.length - listed.length;

  return (
    <section aria-labelledby="dashboard-budgets-title" className="space-y-3">
      <div>
        <h2 id="dashboard-budgets-title" className="text-base font-semibold">
          {m.dashboard_budgets_title()}
        </h2>
        <p className="text-xs text-muted-foreground">
          {m.dashboard_budgets_hint({ month: formatBudgetMonth(data.month) })}
        </p>
      </div>

      <div className="island-shell rounded-xl p-4" data-testid="dashboard-budgets">
        {budgets.length === 0 ? (
          <p className="text-sm text-muted-foreground" data-testid="dashboard-budgets-empty">
            {m.dashboard_budgets_empty()}{" "}
            <Link to="/budgets" className="font-medium">
              {m.dashboard_budgets_empty_cta()}
            </Link>
          </p>
        ) : (
          <>
            <div className="mb-3 flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
              <ul
                className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground"
                data-testid="dashboard-budgets-counts"
              >
                {(["over", "near", "under"] as const).map((state) => (
                  <li key={state} className="flex items-center gap-1.5" data-state={state}>
                    <span className={cn("size-2 rounded-full", BUDGET_STATE_COLOR[state])} />
                    {STATE_LABEL[state](counts[state])}
                  </li>
                ))}
              </ul>
              <Link to="/budgets" className="shrink-0 text-xs font-medium">
                {m.dashboard_budgets_manage()}
              </Link>
            </div>

            <ul className="space-y-3">
              {listed.map((budget) => (
                <li key={budget.id} data-testid="dashboard-budget-row">
                  <div className="flex items-baseline justify-between gap-3 text-sm">
                    <span className="min-w-0 truncate" data-testid="dashboard-budget-category">
                      {budget.category_path.length > 1 && (
                        <span className="text-muted-foreground">
                          {budget.category_path.slice(0, -1).join(" › ")} ›{" "}
                        </span>
                      )}
                      <span className="font-medium">{budget.category_name}</span>
                    </span>
                    <span
                      className={cn(
                        "shrink-0 whitespace-nowrap tabular-nums",
                        budget.over ? "font-medium text-destructive" : "text-muted-foreground",
                      )}
                      data-testid="dashboard-budget-status"
                    >
                      {budgetPercent(budget)}% ·{" "}
                      {budget.over
                        ? m.budget_over_by({ amount: money(-budget.left_minor) })
                        : m.budget_left_amount({ amount: money(budget.left_minor) })}
                    </span>
                  </div>
                  <BudgetProgressBar budget={budget} className="mt-1.5" />
                </li>
              ))}
            </ul>

            {more > 0 && (
              <Link
                to="/budgets"
                className="mt-3 inline-block text-xs font-medium"
                data-testid="dashboard-budgets-more"
              >
                {m.dashboard_budgets_more({ n: more })}
              </Link>
            )}
          </>
        )}
      </div>
    </section>
  );
}
