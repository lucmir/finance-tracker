import { test, expect, type Page } from "./fixtures";

// Each test gets a fresh user with the default categories (Groceries ›
// Vegetables, …) via the signedInUser fixture. Locators are scoped to the
// budget rows or the dialog: dialogs render outside <main>.

const budgetRows = (page: Page) => page.getByTestId("budget-row");
const dialog = (page: Page) => page.getByTestId("budget-dialog");
/** The row whose category path is exactly `path` (e.g. "Groceries"). */
const rowFor = (page: Page, path: string) =>
  budgetRows(page).filter({
    has: page.getByTestId("budget-category").filter({
      hasText: new RegExp(`^${path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`),
    }),
  });

async function addBudget(page: Page, category: string, limit: string) {
  await page.getByRole("button", { name: "Add Budget" }).click();
  await dialog(page).getByLabel("Category").selectOption({ label: category });
  await dialog(page).getByLabel(/Monthly limit/).fill(limit);
  await dialog(page).getByRole("button", { name: "Create Budget" }).click();
  await expect(dialog(page)).toBeHidden();
}

/** Dates in UTC, the timezone that defines "this month" (D3). */
function utcDates() {
  const now = new Date();
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  const lastDayOfPreviousMonth = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 0),
  );
  return { today: iso(now), previousMonth: iso(lastDayOfPreviousMonth), now };
}

async function addTransaction(
  page: Page,
  opts: { date: string; amount: string; category: string; income?: boolean },
) {
  await page.goto("/transactions");
  await page
    .getByRole("banner")
    .getByRole("button", { name: "Add Transaction" })
    .click();
  const modal = page.getByRole("dialog", { name: "New Transaction" });
  await modal.getByLabel("Date").fill(`${opts.date}T12:00`);
  await modal.getByLabel("Description").fill(`${opts.category} ${opts.amount}`);
  await modal
    .getByRole("spinbutton", { name: "Amount", exact: true })
    .fill(opts.amount);
  await modal.getByLabel("Account").selectOption("Main (PLN)");
  await modal.getByLabel("Category").selectOption(opts.category);
  if (opts.income) await modal.getByLabel("Income").check();
  await modal.getByRole("button", { name: "Create Transaction" }).click();
  await expect(modal).toBeHidden();
}

async function openBudgets(page: Page) {
  await page.goto("/budgets");
  await expect(
    page.getByRole("heading", { name: "Budgets", exact: true }),
  ).toBeVisible();
}

test.describe("Budget progress", () => {
  test.beforeEach(async ({ page, signedInUser: _signedInUser }) => {
    await openBudgets(page);
  });

  test("shows spent and what's left, including subcategories", async ({
    page,
  }) => {
    const { today } = utcDates();
    await addBudget(page, "Groceries", "500");
    await addTransaction(page, { date: today, amount: "120", category: "— Vegetables" });
    await addTransaction(page, { date: today, amount: "30", category: "Groceries" });

    await openBudgets(page);
    const row = rowFor(page, "Groceries");
    await expect(row.getByTestId("budget-spent")).toHaveText("150.00");
    await expect(row.getByTestId("budget-limit")).toHaveText("500.00 PLN");
    await expect(row.getByTestId("budget-left")).toHaveText("350.00 PLN");
    await expect(row.getByTestId("budget-progress")).toHaveAttribute(
      "aria-valuenow",
      "30",
    );
    await expect(row).toHaveAttribute("data-state", "under");
    await expect(row.getByTestId("budget-over-badge")).toHaveCount(0);
  });

  test("shows the over-budget state; income doesn't reduce spending", async ({
    page,
  }) => {
    const { today } = utcDates();
    await addBudget(page, "Transport", "100");
    await addTransaction(page, { date: today, amount: "150", category: "— Fuel" });
    await addTransaction(page, {
      date: today,
      amount: "200",
      category: "Transport",
      income: true,
    });

    await openBudgets(page);
    const row = rowFor(page, "Transport");
    await expect(row.getByTestId("budget-spent")).toHaveText("150.00");
    await expect(row.getByTestId("budget-left")).toHaveText("Over by 50.00 PLN");
    await expect(row.getByTestId("budget-over-badge")).toHaveText("Over budget");
    await expect(row).toHaveAttribute("data-state", "over");
  });

  test("at exactly the limit, a budget is close but not over", async ({
    page,
  }) => {
    const { today } = utcDates();
    await addBudget(page, "Shopping", "100");
    await addTransaction(page, { date: today, amount: "100", category: "— Clothing" });

    await openBudgets(page);
    const row = rowFor(page, "Shopping");
    await expect(row.getByTestId("budget-left")).toHaveText("0.00 PLN");
    await expect(row).toHaveAttribute("data-state", "near");
    await expect(row.getByTestId("budget-over-badge")).toHaveCount(0);
  });

  test("stays readable on a phone-sized screen", async ({ page }) => {
    const { today } = utcDates();
    await addBudget(page, "Groceries › Vegetables", "100");
    await addTransaction(page, { date: today, amount: "150", category: "— Vegetables" });

    await page.setViewportSize({ width: 375, height: 812 });
    await openBudgets(page);
    const row = rowFor(page, "Groceries › Vegetables");

    // Every part of the row is on screen, with room to read it.
    for (const testId of [
      "budget-category",
      "budget-over-badge",
      "budget-progress",
      "budget-spent",
      "budget-left",
      "edit-budget",
    ]) {
      await expect(row.getByTestId(testId), testId).toBeVisible();
    }
    const category = await row.getByTestId("budget-category").boundingBox();
    expect(category?.width ?? 0).toBeGreaterThan(80);

    // The badge and the amounts don't overlap.
    const badge = await row.getByTestId("budget-over-badge").boundingBox();
    const spent = await row.getByTestId("budget-spent").boundingBox();
    expect(badge && spent && badge.y + badge.height <= spent.y).toBe(true);

    // Nothing pushes the page wider than the screen.
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - window.innerWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
  });

  test("counts only the current month", async ({ page }) => {
    const { previousMonth, now } = utcDates();
    await addBudget(page, "Health", "100");
    await addTransaction(page, {
      date: previousMonth,
      amount: "80",
      category: "Health",
    });

    await openBudgets(page);
    const row = rowFor(page, "Health");
    await expect(row.getByTestId("budget-spent")).toHaveText("0.00");
    await expect(row.getByTestId("budget-left")).toHaveText("100.00 PLN");
    const monthLabel = new Intl.DateTimeFormat("en", {
      month: "long",
      year: "numeric",
      timeZone: "UTC",
    }).format(now);
    await expect(page.getByTestId("budgets-month")).toHaveText(
      `Spending in ${monthLabel}`,
    );
  });
});

test.describe("Budgets", () => {
  test.beforeEach(async ({ page, signedInUser: _signedInUser }) => {
    await page.goto("/budgets");
    await expect(
      page.getByRole("heading", { name: "Budgets", exact: true }),
    ).toBeVisible();
  });

  test("is in the main navigation and starts empty", async ({ page }) => {
    await page.goto("/dashboard");
    await page.getByRole("link", { name: "Budgets" }).click();
    await expect(page).toHaveURL("/budgets");
    await expect(page.getByTestId("budgets-empty")).toBeVisible();
    await expect(budgetRows(page)).toHaveCount(0);
  });

  test("adds a budget for a category", async ({ page }) => {
    await addBudget(page, "Groceries", "500");

    const row = budgetRows(page).filter({ hasText: "Groceries" });
    await expect(row).toHaveCount(1);
    await expect(row.getByTestId("budget-limit")).toHaveText("500.00 PLN");
    await expect(page.getByTestId("budgets-empty")).toBeHidden();
  });

  test("shows the full path of a subcategory", async ({ page }) => {
    await addBudget(page, "Groceries › Vegetables", "120,50");

    const row = budgetRows(page).filter({ hasText: "Vegetables" });
    await expect(row.getByTestId("budget-category")).toHaveText(
      "Groceries › Vegetables",
    );
    await expect(row.getByTestId("budget-limit")).toHaveText("120.50 PLN");
  });

  test("changes a budget's limit", async ({ page }) => {
    await addBudget(page, "Transport", "300");

    const row = budgetRows(page).filter({ hasText: "Transport" });
    await row.getByTestId("edit-budget").click();
    await expect(dialog(page).getByLabel(/Monthly limit/)).toHaveValue("300.00");
    await dialog(page).getByLabel(/Monthly limit/).fill("450.75");
    await dialog(page).getByRole("button", { name: "Save Changes" }).click();

    await expect(dialog(page)).toBeHidden();
    await expect(row.getByTestId("budget-limit")).toHaveText("450.75 PLN");
  });

  test("removes a budget", async ({ page }) => {
    await addBudget(page, "Health", "80");

    await budgetRows(page)
      .filter({ hasText: "Health" })
      .getByTestId("delete-budget")
      .click();
    await expect(page.getByTestId("delete-budget-dialog")).toContainText(
      "Health",
    );
    await page.getByTestId("delete-budget-confirm").click();

    await expect(page.getByTestId("delete-budget-dialog")).toBeHidden();
    await expect(budgetRows(page)).toHaveCount(0);
    await expect(page.getByTestId("budgets-empty")).toBeVisible();
  });

  test("validates the category and the limit", async ({ page }) => {
    await page.getByRole("button", { name: "Add Budget" }).click();
    const form = dialog(page);
    const submit = form.getByRole("button", { name: "Create Budget" });

    await form.getByLabel(/Monthly limit/).fill("100");
    await submit.click();
    await expect(form.getByRole("alert")).toHaveText("Choose a category.");

    await form.getByLabel("Category").selectOption({ label: "Groceries" });
    for (const limit of ["", "0", "-5", "abc"]) {
      await form.getByLabel(/Monthly limit/).fill(limit);
      await submit.click();
      await expect(form.getByRole("alert")).toHaveText(
        "Enter a monthly limit greater than zero.",
      );
    }

    await form.getByLabel(/Monthly limit/).fill("99999999");
    await submit.click();
    await expect(form.getByRole("alert")).toHaveText("That limit is too large.");

    await form.getByRole("button", { name: "Cancel" }).click();
    await expect(form).toBeHidden();
    await expect(budgetRows(page)).toHaveCount(0);
  });

  test("only offers categories that don't have a budget yet", async ({
    page,
  }) => {
    await addBudget(page, "Groceries", "500");

    await page.getByRole("button", { name: "Add Budget" }).click();
    const select = dialog(page).getByLabel("Category");
    await expect(select.locator("option", { hasText: /^Groceries$/ })).toHaveCount(0);
    await expect(
      select.locator("option", { hasText: "Groceries › Vegetables" }),
    ).toHaveCount(1);
  });

  test("warns, without blocking, when a subcategory budget is above its parent's", async ({
    page,
  }) => {
    await addBudget(page, "Groceries", "400");

    await page.getByRole("button", { name: "Add Budget" }).click();
    const form = dialog(page);
    const warning = form.getByTestId("budget-hierarchy-warning");
    await form.getByLabel("Category").selectOption({ label: "Groceries › Fruits" });

    await form.getByLabel(/Monthly limit/).fill("600");
    await expect(warning).toContainText(
      "higher than the Groceries budget (400.00 PLN)",
    );
    await form.getByLabel(/Monthly limit/).fill("300");
    await expect(warning).toBeHidden();

    await form.getByLabel(/Monthly limit/).fill("6000");
    await expect(warning).toBeVisible();
    await form.getByRole("button", { name: "Create Budget" }).click();
    await expect(form).toBeHidden();
    await expect(
      rowFor(page, "Groceries › Fruits").getByTestId("budget-limit"),
    ).toHaveText("6000.00 PLN");
  });

  test("warns when a parent budget is lowered below a subcategory's", async ({
    page,
  }) => {
    await addBudget(page, "Groceries › Fruits", "300");
    await addBudget(page, "Groceries", "500");

    await rowFor(page, "Groceries").getByTestId("edit-budget").click();
    const form = dialog(page);
    const warning = form.getByTestId("budget-hierarchy-warning");
    await expect(warning).toBeHidden();

    await form.getByLabel(/Monthly limit/).fill("200");
    await expect(warning).toContainText(
      "Groceries › Fruits has a higher budget (300.00 PLN)",
    );
    await form.getByRole("button", { name: "Save Changes" }).click();
    await expect(form).toBeHidden();
    await expect(rowFor(page, "Groceries").getByTestId("budget-limit")).toHaveText(
      "200.00 PLN",
    );
  });

  test("deleting a category removes its budget", async ({ page }) => {
    await addBudget(page, "Groceries › Vegetables", "100");
    await addBudget(page, "Transport", "300");

    await page.getByRole("link", { name: "Categories" }).click();
    await expect(page).toHaveURL("/categories");
    await page
      .getByTestId("category-row")
      .filter({ hasText: "Vegetables" })
      .getByTestId("delete-category")
      .click();
    await page
      .getByRole("alertdialog")
      .getByRole("button", { name: "Delete" })
      .click();
    await expect(page.getByRole("alertdialog")).toBeHidden();

    await page.getByRole("link", { name: "Budgets" }).click();
    await expect(page).toHaveURL("/budgets");
    await expect(budgetRows(page)).toHaveCount(1);
    await expect(budgetRows(page)).toContainText("Transport");
  });
});

test.describe("Budget limit on the Free plan", () => {
  test.beforeEach(async ({ page, signedInUser: _signedInUser }) => {
    await openBudgets(page);
  });

  test("allows 3 budgets on Free, then blocks adding with an upgrade link", async ({
    page,
  }) => {
    await expect(page.getByTestId("budgets-plan-usage")).toHaveText(
      "0 of 3 budgets on the Free plan.",
    );
    await addBudget(page, "Groceries", "400");
    await addBudget(page, "Transport", "300");
    await addBudget(page, "Health", "100");

    await expect(page.getByTestId("budgets-plan-usage")).toHaveText(
      "3 of 3 budgets on the Free plan.",
    );
    await expect(page.getByRole("button", { name: "Add Budget" })).toBeDisabled();
    const notice = page.getByTestId("budget-limit-notice");
    await expect(notice).toContainText(
      "The Free plan includes up to 3 budgets. Upgrade to Pro for unlimited budgets.",
    );
    await notice.getByRole("link", { name: "Upgrade to Pro" }).click();
    await expect(page).toHaveURL("/billing");
    await expect(page.getByTestId("billing-budgets-usage")).toHaveText(
      "3 of 3 budgets",
    );
  });

  test("Pro is unlimited; a downgrade keeps every budget but blocks new ones", async ({
    page,
  }) => {
    await page.request.post("/test-set-plan?plan=pro");
    await openBudgets(page);
    await expect(page.getByTestId("budgets-plan-usage")).toHaveCount(0);
    for (const [category, limit] of [
      ["Groceries", "400"],
      ["Transport", "300"],
      ["Health", "100"],
      ["Shopping", "200"],
    ]) {
      await addBudget(page, category, limit);
    }
    await expect(budgetRows(page)).toHaveCount(4);
    await expect(page.getByTestId("budget-limit-notice")).toHaveCount(0);

    await page.request.post("/test-set-plan?plan=free&status=canceled");
    await openBudgets(page);
    await expect(budgetRows(page)).toHaveCount(4);
    await expect(page.getByTestId("budgets-plan-usage")).toHaveText(
      "4 of 3 budgets on the Free plan.",
    );
    await expect(page.getByRole("button", { name: "Add Budget" })).toBeDisabled();
    await expect(page.getByTestId("budget-limit-notice")).toBeVisible();

    await page.goto("/billing");
    await expect(page.getByTestId("billing-budgets-usage")).toHaveText(
      "4 of 3 budgets",
    );
  });
});
