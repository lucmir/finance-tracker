import { Link, createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { m } from "#/paraglide/messages";
import { getLocale } from "#/paraglide/runtime";
import { cn } from "#/lib/utils";
import { formatMinor, parseAmountToMinor } from "#/lib/money";
import { MAX_BUDGET_LIMIT_MINOR } from "#/lib/budget-limits";
import { findHierarchyConflict } from "#/lib/budget-hierarchy";
import { DeleteButton, EditButton } from "#/components/ui/action-buttons";
import { Button } from "#/components/ui/button";
import { Input } from "#/components/ui/input";
import { Label } from "#/components/ui/label";
import { Select, SelectItem } from "#/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "#/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "#/components/ui/alert-dialog";
import {
  createBudget,
  deleteBudget,
  getBudgets,
  updateBudget,
} from "#/server/budgets.functions";
import { getCategories } from "#/server/categories.functions";

export const Route = createFileRoute("/_authed/budgets")({
  component: BudgetsPage,
});

type Budget = Awaited<ReturnType<typeof getBudgets>>["budgets"][number];
type Category = Awaited<ReturnType<typeof getCategories>>[number];

const BUDGETS_QUERY_KEY = ["budgets"] as const;
const CATEGORIES_QUERY_KEY = ["categories"] as const;

// --- Helpers ---

/** Every category in tree order, labelled with its full path. */
function categoryOptions(categories: Category[]) {
  const ids = new Set(categories.map((c) => c.id));
  const childrenOf = new Map<string | null, Category[]>();
  for (const c of categories) {
    const parent = c.parent_id && ids.has(c.parent_id) ? c.parent_id : null;
    childrenOf.set(parent, [...(childrenOf.get(parent) ?? []), c]);
  }
  const options: { id: string; label: string }[] = [];
  const visited = new Set<string>();
  const walk = (parent: string | null, path: string[]) => {
    const children = [...(childrenOf.get(parent) ?? [])].sort(
      (a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0),
    );
    for (const c of children) {
      if (visited.has(c.id)) continue;
      visited.add(c.id);
      const label = [...path, c.name];
      options.push({ id: c.id, label: label.join(" › ") });
      walk(c.id, label);
    }
  };
  walk(null, []);
  return options;
}

/** Parses a limit typed by the user; returns minor units or a message. */
function parseLimit(raw: string): { minor: number } | { message: string } {
  const minor = parseAmountToMinor(raw);
  if (minor === null || minor <= 0) return { message: m.budget_limit_invalid() };
  if (minor > MAX_BUDGET_LIMIT_MINOR) return { message: m.budget_limit_too_large() };
  return { minor };
}

/** Maps a server result's error code to a translated message. */
function errorMessage(result: {
  error?: string;
  code?: string;
  limit?: number;
}): string {
  switch (result.code) {
    case "budget_limit_reached":
      return m.budget_limit_reached({ limit: result.limit ?? 0 });
    case "budget_exists":
      return m.budget_exists();
    case "category_not_found":
      return m.budget_category_not_found();
    case "budget_not_found":
      return m.budget_not_found();
    default:
      return result.error ?? "";
  }
}

const formatLimit = (minor: number) =>
  `${formatMinor(minor)} ${m.analytics_currency()}`;

// --- Row ---

/** Share of the limit at which a budget is shown as close to it. */
const NEAR_LIMIT_RATIO = 0.8;

type BudgetState = "under" | "near" | "over";

function budgetState(budget: Budget): BudgetState {
  if (budget.over) return "over";
  return budget.spent_minor >= budget.limit_minor * NEAR_LIMIT_RATIO
    ? "near"
    : "under";
}

const BAR_COLOR: Record<BudgetState, string> = {
  under: "bg-emerald-500",
  near: "bg-amber-500",
  over: "bg-destructive",
};

/** "2026-11" → "November 2026" in the current locale. */
function formatMonth(month: string): string {
  return new Intl.DateTimeFormat(getLocale(), {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(`${month}-01T00:00:00Z`));
}

function BudgetRowItem({
  budget,
  onEdit,
  onDelete,
}: {
  budget: Budget;
  onEdit: (budget: Budget) => void;
  onDelete: (budget: Budget) => void;
}) {
  const parents = budget.category_path.slice(0, -1);
  const state = budgetState(budget);
  const percent = Math.round((budget.spent_minor * 100) / budget.limit_minor);
  return (
    // Narrow screens: a card (name + actions, then the bar, then amounts).
    // From md up: one table row. The amounts wrapper becomes
    // `display: contents` there, so its two children are columns again.
    <div
      className="flex flex-wrap items-center gap-x-3 gap-y-2 px-3 py-3 hover:bg-accent/50 transition-colors md:flex-nowrap"
      role="row"
      data-testid="budget-row"
      data-state={state}
    >
      <span
        className="order-1 size-4 shrink-0 rounded-full border border-border/50 shadow-sm"
        style={{ backgroundColor: budget.category_color }}
      />
      <div className="order-2 min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 md:flex-nowrap">
          <span
            className="min-w-0 break-words text-sm md:truncate"
            data-testid="budget-category"
          >
            {parents.length > 0 && (
              <span className="text-muted-foreground">
                {parents.join(" › ")} ›{" "}
              </span>
            )}
            <span className="font-medium">{budget.category_name}</span>
          </span>
          {state === "over" && (
            <span
              className="shrink-0 rounded-full bg-destructive/10 px-2 py-0.5 text-xs font-medium text-destructive"
              data-testid="budget-over-badge"
            >
              {m.budget_over_badge()}
            </span>
          )}
        </div>
        <div
          className="mt-1.5 h-1.5 max-w-md overflow-hidden rounded-full bg-muted"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.min(percent, 100)}
          aria-label={m.budget_progress_label({ percent })}
          data-testid="budget-progress"
        >
          <div
            className={cn("h-full rounded-full", BAR_COLOR[state])}
            style={{ width: `${Math.min(percent, 100)}%` }}
          />
        </div>
      </div>
      <div className="order-4 flex w-full items-baseline justify-between gap-3 pl-7 text-sm tabular-nums md:contents">
        <span className="whitespace-nowrap md:order-3 md:w-48 md:shrink-0 md:text-right">
          <span data-testid="budget-spent">{formatMinor(budget.spent_minor)}</span>
          <span className="text-muted-foreground"> / </span>
          <span data-testid="budget-limit">{formatLimit(budget.limit_minor)}</span>
        </span>
        <span
          className={cn(
            "whitespace-nowrap text-right md:order-4 md:w-36 md:shrink-0",
            budget.over && "font-medium text-destructive",
          )}
          data-testid="budget-left"
        >
          {budget.over
            ? m.budget_over_by({ amount: formatLimit(-budget.left_minor) })
            : formatLimit(budget.left_minor)}
        </span>
      </div>
      <div className="order-3 flex shrink-0 items-center justify-end gap-1 md:order-5 md:w-32">
        <EditButton onClick={() => onEdit(budget)} data-testid="edit-budget" />
        <DeleteButton
          onClick={() => onDelete(budget)}
          data-testid="delete-budget"
        />
      </div>
    </div>
  );
}

// --- Add / change limit dialog ---

function BudgetForm({
  isOpen,
  editing,
  options,
  hasCategories,
  budgets,
  parentOf,
  error,
  onSubmit,
  onClose,
}: {
  isOpen: boolean;
  /** The budget whose limit is being changed, or null to add one. */
  editing: Budget | null;
  options: { id: string; label: string }[];
  hasCategories: boolean;
  /** All budgets and the category tree, for the parent/child warning (D10). */
  budgets: Budget[];
  parentOf: (categoryId: string) => string | null | undefined;
  error: string | null;
  onSubmit: (data: { categoryId: string; limitMinor: number }) => Promise<void>;
  onClose: () => void;
}) {
  const [categoryId, setCategoryId] = useState("");
  const [limit, setLimit] = useState("");
  const [validationError, setValidationError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (isOpen) {
      setCategoryId("");
      setLimit(editing ? formatMinor(editing.limit_minor) : "");
      setValidationError(null);
      setSubmitting(false);
    }
  }, [isOpen, editing]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editing && !categoryId) {
      setValidationError(m.budget_category_required());
      return;
    }
    const parsed = parseLimit(limit);
    if ("message" in parsed) {
      setValidationError(parsed.message);
      return;
    }
    setValidationError(null);
    setSubmitting(true);
    try {
      await onSubmit({
        categoryId: editing?.category_id ?? categoryId,
        limitMinor: parsed.minor,
      });
    } finally {
      setSubmitting(false);
    }
  };

  const noOptions = !editing && options.length === 0;

  // Non-blocking warning when this limit is inconsistent with a parent or
  // subcategory budget (D10). Recomputed as the user types.
  const selectedCategoryId = editing?.category_id ?? categoryId;
  const parsedLimit = parseLimit(limit);
  const conflict =
    selectedCategoryId && "minor" in parsedLimit
      ? findHierarchyConflict({
          categoryId: selectedCategoryId,
          limitMinor: parsedLimit.minor,
          budgets,
          parentOf,
          excludeBudgetId: editing?.id,
        })
      : null;
  const warning = conflict
    ? (conflict.kind === "above_ancestor"
        ? m.budget_warning_above_parent
        : m.budget_warning_below_child)({
        category: conflict.budget.category_path.join(" › "),
        limit: formatLimit(conflict.budget.limit_minor),
      })
    : null;

  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
      <DialogContent data-testid="budget-dialog">
        <DialogHeader>
          <DialogTitle>
            {editing ? m.edit_budget_title() : m.add_budget()}
          </DialogTitle>
          <DialogDescription>
            {editing
              ? m.edit_budget_description({
                  category: editing.category_path.join(" › "),
                })
              : m.budgets_subtitle()}
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-4" noValidate>
          {!editing && (
            <div>
              <Label htmlFor="budget-category" className="mb-1">
                {m.budget_category_label()}
              </Label>
              <Select
                id="budget-category"
                value={categoryId}
                onChange={(e) => setCategoryId(e.target.value)}
                disabled={noOptions}
              >
                <SelectItem value="">{m.budget_category_placeholder()}</SelectItem>
                {options.map((o) => (
                  <SelectItem key={o.id} value={o.id}>
                    {o.label}
                  </SelectItem>
                ))}
              </Select>
              {noOptions && (
                <p className="mt-1 text-xs text-muted-foreground">
                  {hasCategories
                    ? m.budget_all_categories_used()
                    : m.no_categories_yet()}
                </p>
              )}
            </div>
          )}

          <div>
            <Label htmlFor="budget-limit" className="mb-1">
              {m.budget_limit_label({ currency: m.analytics_currency() })}
            </Label>
            <Input
              id="budget-limit"
              type="text"
              inputMode="decimal"
              value={limit}
              onChange={(e) => setLimit(e.target.value)}
              placeholder="0.00"
              autoFocus={!!editing}
            />
          </div>

          {warning && (
            <div
              className="p-2 rounded-md bg-amber-500/10 text-amber-600 text-xs"
              role="status"
              data-testid="budget-hierarchy-warning"
            >
              {warning}
            </div>
          )}

          {(validationError || error) && (
            <div className="text-destructive text-sm" role="alert">
              {validationError ?? error}
            </div>
          )}

          <DialogFooter className="pt-2">
            <Button
              type="button"
              variant="outline"
              onClick={onClose}
              disabled={submitting}
            >
              {m.cancel()}
            </Button>
            <Button type="submit" disabled={submitting || noOptions}>
              {submitting
                ? editing
                  ? m.saving()
                  : m.creating()
                : editing
                  ? m.save_changes()
                  : m.create_budget_btn()}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// --- Remove confirmation ---

function RemoveBudgetDialog({
  budget,
  error,
  onConfirm,
  onCancel,
}: {
  budget: Budget | null;
  error: string | null;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <AlertDialog open={!!budget} onOpenChange={(open) => !open && onCancel()}>
      <AlertDialogContent
        className="sm:max-w-sm"
        data-testid="delete-budget-dialog"
      >
        <AlertDialogHeader>
          <AlertDialogTitle>{m.delete_budget_title()}</AlertDialogTitle>
          <AlertDialogDescription>
            {m.delete_budget_confirm({
              category: budget?.category_path.join(" › ") ?? "",
            })}
          </AlertDialogDescription>
        </AlertDialogHeader>
        {error && (
          <div
            className="text-destructive text-sm p-3 rounded-md bg-destructive/10"
            role="alert"
          >
            {error}
          </div>
        )}
        <AlertDialogFooter>
          <AlertDialogCancel onClick={onCancel}>{m.cancel()}</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            onClick={(e) => {
              // Keep the dialog open until the server confirms.
              e.preventDefault();
              onConfirm();
            }}
            data-testid="delete-budget-confirm"
          >
            {m.remove_budget_btn()}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

// --- Page ---

function BudgetsPage() {
  const queryClient = useQueryClient();
  const getBudgetsFn = useServerFn(getBudgets);
  const getCategoriesFn = useServerFn(getCategories);
  const createBudgetFn = useServerFn(createBudget);
  const updateBudgetFn = useServerFn(updateBudget);
  const deleteBudgetFn = useServerFn(deleteBudget);

  const { data, isLoading } = useQuery({
    queryKey: BUDGETS_QUERY_KEY,
    queryFn: () => getBudgetsFn(),
    refetchOnMount: true,
    staleTime: 0,
  });
  const budgets = useMemo(() => data?.budgets ?? [], [data]);
  // Free plan limit (T8). Budgets above it after a downgrade are kept; only
  // adding is blocked (D8).
  const maxBudgets = data?.maxBudgets ?? null;
  const atLimit = maxBudgets !== null && budgets.length >= maxBudgets;
  const { data: categories = [] } = useQuery({
    queryKey: CATEGORIES_QUERY_KEY,
    queryFn: () => getCategoriesFn(),
  });

  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: BUDGETS_QUERY_KEY });
  const createMutation = useMutation({
    mutationFn: (data: { categoryId: string; limitMinor: number }) =>
      createBudgetFn({ data }),
    onSuccess: invalidate,
  });
  const updateMutation = useMutation({
    mutationFn: (data: { id: string; limitMinor: number }) =>
      updateBudgetFn({ data }),
    onSuccess: invalidate,
  });
  const deleteMutation = useMutation({
    mutationFn: (data: { id: string }) => deleteBudgetFn({ data }),
    onSuccess: invalidate,
  });

  const [isFormOpen, setIsFormOpen] = useState(false);
  const [editing, setEditing] = useState<Budget | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [removing, setRemoving] = useState<Budget | null>(null);
  const [removeError, setRemoveError] = useState<string | null>(null);

  const parentById = useMemo(
    () => new Map(categories.map((c) => [c.id, c.parent_id])),
    [categories],
  );

  // One budget per category: only offer categories without one.
  const options = useMemo(() => {
    const budgeted = new Set(budgets.map((b) => b.category_id));
    return categoryOptions(categories).filter((o) => !budgeted.has(o.id));
  }, [categories, budgets]);

  const openAdd = () => {
    setEditing(null);
    setFormError(null);
    setIsFormOpen(true);
  };
  const openEdit = (budget: Budget) => {
    setEditing(budget);
    setFormError(null);
    setIsFormOpen(true);
  };
  const closeForm = () => {
    setIsFormOpen(false);
    setEditing(null);
    setFormError(null);
  };

  const handleSubmit = async (data: {
    categoryId: string;
    limitMinor: number;
  }) => {
    setFormError(null);
    try {
      const result = editing
        ? await updateMutation.mutateAsync({
            id: editing.id,
            limitMinor: data.limitMinor,
          })
        : await createMutation.mutateAsync(data);
      if ("error" in result) {
        setFormError(errorMessage(result));
        return;
      }
      closeForm();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleRemove = async () => {
    if (!removing) return;
    setRemoveError(null);
    try {
      const result = await deleteMutation.mutateAsync({ id: removing.id });
      if ("error" in result) {
        setRemoveError(errorMessage(result));
        return;
      }
      setRemoving(null);
    } catch (err) {
      setRemoveError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div className="min-h-screen">
      <header className="border-b border-line/50 bg-header-bg/80 backdrop-blur-sm">
        <div className="page-wrap py-4 flex items-center justify-between">
          <div>
            <h1 className="text-xl font-bold display-title">
              {m.budgets_title()}
            </h1>
            <p className="text-sm text-muted-foreground mt-0.5">
              {m.budgets_subtitle()}
              {data?.month && (
                <>
                  {" "}
                  <span data-testid="budgets-month">
                    {m.budgets_month({ month: formatMonth(data.month) })}
                  </span>
                </>
              )}
            </p>
            {maxBudgets !== null && (
              <p
                className="text-xs text-muted-foreground mt-0.5"
                data-testid="budgets-plan-usage"
              >
                {m.budgets_plan_usage({
                  used: budgets.length,
                  limit: maxBudgets,
                })}
              </p>
            )}
          </div>
          <Button onClick={openAdd} disabled={atLimit}>
            <svg
              className="size-4"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={2}
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M12 4v16m8-8H4"
              />
            </svg>
            {m.add_budget()}
          </Button>
        </div>
      </header>

      <main className="page-wrap py-8">
        {atLimit && (
          <div
            className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-line/50 bg-accent/40 p-3 text-sm"
            role="status"
            data-testid="budget-limit-notice"
          >
            <span>{m.budget_limit_reached({ limit: maxBudgets ?? 0 })}</span>
            <Link
              to="/billing"
              className="shrink-0 font-medium text-primary underline-offset-4 hover:underline"
            >
              {m.billing_upgrade()}
            </Link>
          </div>
        )}
        {isLoading ? (
          <div className="flex items-center justify-center py-16">
            <div className="flex flex-col items-center gap-3">
              <div className="size-6 border-2 border-primary border-t-transparent rounded-full animate-spin" />
              <span className="text-sm text-muted-foreground">{m.loading()}</span>
            </div>
          </div>
        ) : budgets.length === 0 ? (
          <div
            className="flex flex-col items-center justify-center py-16 text-center"
            data-testid="budgets-empty"
          >
            <h3 className="text-base font-medium mb-1">{m.no_budgets_yet()}</h3>
            <p className="text-sm text-muted-foreground mb-4 max-w-sm">
              {m.create_first_budget()}
            </p>
          </div>
        ) : (
          <div className="island-shell rounded-xl overflow-hidden">
            <div className="hidden items-center gap-3 px-3 py-2 bg-muted/40 border-b border-line/50 text-xs font-semibold text-muted-foreground uppercase tracking-wider md:flex">
              <span className="size-4 shrink-0" aria-hidden="true" />
              <span className="flex-1">{m.category_column()}</span>
              <span className="w-48 shrink-0 text-right">
                {m.budget_spent_limit_column()}
              </span>
              <span className="w-36 shrink-0 text-right">{m.budget_left_column()}</span>
              <span className="w-32 text-right">{m.actions_column()}</span>
            </div>
            <div className="divide-y divide-line/30">
              {budgets.map((budget) => (
                <BudgetRowItem
                  key={budget.id}
                  budget={budget}
                  onEdit={openEdit}
                  onDelete={(b) => {
                    setRemoveError(null);
                    setRemoving(b);
                  }}
                />
              ))}
            </div>
          </div>
        )}
      </main>

      <BudgetForm
        isOpen={isFormOpen}
        editing={editing}
        options={options}
        hasCategories={categories.length > 0}
        budgets={budgets}
        parentOf={(id) => parentById.get(id)}
        error={formError}
        onSubmit={handleSubmit}
        onClose={closeForm}
      />

      <RemoveBudgetDialog
        budget={removing}
        error={removeError}
        onConfirm={handleRemove}
        onCancel={() => {
          setRemoving(null);
          setRemoveError(null);
        }}
      />
    </div>
  );
}
