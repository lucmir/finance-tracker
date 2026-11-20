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
