import { test, expect, type Page } from "./fixtures";

// Dashboard "Budgets this month" card (T12): counts per state, the most
// urgent budgets first, "+ N more", an empty state, and independence from
// the dashboard's period filter.

const todayUtc = () => new Date().toISOString().slice(0, 10);
const card = (page: Page) => page.getByTestId("dashboard-budgets");
const rows = (page: Page) => card(page).getByTestId("dashboard-budget-row");

async function addBudget(page: Page, category: string, limit: string) {
  await page.goto("/budgets");
  await page.getByRole("button", { name: "Add Budget" }).click();
  const dialog = page.getByTestId("budget-dialog");
  await dialog.getByLabel("Category").selectOption({ label: category });
  await dialog.getByLabel(/Monthly limit/).fill(limit);
  await dialog.getByRole("button", { name: "Create Budget" }).click();
  await expect(dialog).toBeHidden();
}

async function addExpense(page: Page, amount: string, category: string) {
  await page.goto("/transactions");
  await page
    .getByRole("banner")
    .getByRole("button", { name: "Add Transaction" })
    .click();
  const modal = page.getByRole("dialog", { name: "New Transaction" });
  await modal.getByLabel("Date").fill(`${todayUtc()}T12:00`);
  await modal.getByLabel("Description").fill(`${category} ${amount}`);
  await modal.getByRole("spinbutton", { name: "Amount", exact: true }).fill(amount);
  await modal.getByLabel("Account").selectOption("Main (PLN)");
  await modal.getByLabel("Category").selectOption(category);
  await modal.getByRole("button", { name: "Create Transaction" }).click();
  await expect(modal).toBeHidden();
}

test.describe("Dashboard budgets card", () => {
  test.beforeEach(async ({ signedInUser: _signedInUser }) => {});

  test("shows an empty state that leads to the Budgets page", async ({ page }) => {
    await page.goto("/dashboard");
    await expect(card(page).getByTestId("dashboard-budgets-empty")).toHaveText(
      "No budgets yet. Set a monthly limit for a category",
    );
    await card(page)
      .getByRole("link", { name: "Set a monthly limit for a category" })
      .click();
    await expect(page).toHaveURL("/budgets");
  });

  test("counts budgets per state and lists the most urgent first", async ({
    page,
  }) => {
    await addBudget(page, "Health", "1000");
    await addBudget(page, "Groceries", "100");
    await addBudget(page, "Transport", "100");
    await addExpense(page, "90", "— Vegetables");
    await addExpense(page, "150", "— Fuel");

    await page.goto("/dashboard");
    const counts = card(page).getByTestId("dashboard-budgets-counts");
    await expect(counts.locator('[data-state="over"]')).toHaveText("1 over");
    await expect(counts.locator('[data-state="near"]')).toHaveText(
      "1 close to the limit",
    );
    await expect(counts.locator('[data-state="under"]')).toHaveText("1 on track");

    await expect(rows(page).getByTestId("dashboard-budget-category")).toHaveText([
      "Transport",
      "Groceries",
      "Health",
    ]);
    await expect(rows(page).nth(0).getByTestId("dashboard-budget-status")).toHaveText(
      "150% · Over by 50.00 PLN",
    );
    await expect(rows(page).nth(1).getByTestId("dashboard-budget-status")).toHaveText(
      "90% · 10.00 PLN left",
    );

    // Budgets are always this month: other dashboard periods don't change them.
    await page.getByRole("button", { name: "Last Year" }).click();
    await expect(rows(page)).toHaveCount(3);
    await expect(rows(page).first()).toContainText("Transport");

    await card(page).getByRole("link", { name: "Manage budgets" }).click();
    await expect(page).toHaveURL("/budgets");
  });

  test("lists 4 budgets and links to the rest", async ({ page }) => {
    await page.request.post("/test-set-plan?plan=pro");
    for (const category of ["Groceries", "Transport", "Health", "Shopping", "Housing"]) {
      await addBudget(page, category, "100");
    }

    await page.goto("/dashboard");
    await expect(rows(page)).toHaveCount(4);
    const more = card(page).getByTestId("dashboard-budgets-more");
    await expect(more).toHaveText("+ 1 more");
    await more.click();
    await expect(page).toHaveURL("/budgets");
  });
});
