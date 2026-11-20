import { createMiddleware } from "@tanstack/react-start";

//
// Runs the over-budget check after a server function that can change
// spending (decision D1 in PLAN.md). Attached with `.middleware([...])` to:
// transactions (create/update/delete), receipt save, category delete,
// categorization rules (apply/recategorize), import batch delete, and budget
// create/update. `confirmImport` streams its work, so this would run before
// its rows exist; it calls the check at the end of its stream instead.
//
// The user id comes from the request context that `requireUserId()` set in
// the handler, so there's no second session lookup; anonymous or rejected
// requests are skipped. The check never throws.
//
// This module is imported by *.functions.ts files, which the client bundle
// also loads: server code is loaded with a dynamic import inside `.server()`
// (stripped from the client build), as in src/start.ts.
export const budgetAlertsAfter = createMiddleware({ type: "function" }).server(
  async ({ next }) => {
    const result = await next();
    const { getRequestContext } = await import("#/server/request-context");
    const userId = getRequestContext()?.userId;
    if (userId) {
      const { checkBudgetAlertsSafely } = await import(
        "#/server/budget-alerts.server"
      );
      await checkBudgetAlertsSafely(userId);
    }
    return result;
  },
);
