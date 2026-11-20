import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { MAX_BUDGET_LIMIT_MINOR } from "#/lib/budget-limits";
import {
  createBudget as createBudgetForUser,
  deleteBudget as deleteBudgetForUser,
  listBudgets,
  updateBudgetLimit,
} from "#/server/budgets.server";
import { requireUserId } from "#/server/session";

// Integer minor units (grosze/cents), positive, within the integer column.
const limitMinor = z.number().int().positive().max(MAX_BUDGET_LIMIT_MINOR);

export const getBudgets = createServerFn({ method: "GET" }).handler(
  async () => {
    const userId = await requireUserId();
    return listBudgets(userId);
  },
);

export const createBudget = createServerFn({ method: "POST" })
  .inputValidator(z.object({ categoryId: z.string().min(1), limitMinor }))
  .handler(async ({ data }) => {
    const userId = await requireUserId();
    return createBudgetForUser(userId, data);
  });

export const updateBudget = createServerFn({ method: "POST" })
  .inputValidator(z.object({ id: z.string().min(1), limitMinor }))
  .handler(async ({ data }) => {
    const userId = await requireUserId();
    return updateBudgetLimit(userId, data);
  });

export const deleteBudget = createServerFn({ method: "POST" })
  .inputValidator(z.object({ id: z.string().min(1) }))
  .handler(async ({ data }) => {
    const userId = await requireUserId();
    return deleteBudgetForUser(userId, data.id);
  });
