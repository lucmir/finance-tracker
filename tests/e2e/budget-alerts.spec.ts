import { writeFileSync } from "node:fs";
import { test, expect, type Page } from "./fixtures";

// Over-budget emails (T7): sent from the server function middleware after a
// spending change, from the end of the CSV import stream, and after creating
// or lowering a budget (D1, D5). Emails are captured in TEST_MODE and read
// back through /test-emails?to=.

const todayUtc = () => new Date().toISOString().slice(0, 10);

async function emailsTo(page: Page, username: string) {
  const res = await page.request.get(
    `/test-emails?to=${encodeURIComponent(`${username}@example.com`)}`,
  );
  const { emails } = (await res.json()) as {
    emails: { subject: string; text: string }[];
  };
  return emails.filter((e) => e.subject.startsWith("Budget exceeded"));
}

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

test.describe("Over-budget email", () => {
  test("is sent once when spending goes over, not again that month", async ({
    page,
    signedInUser,
  }) => {
    await addBudget(page, "Transport", "100");
    await addExpense(page, "60", "— Fuel");
    expect(await emailsTo(page, signedInUser.username)).toHaveLength(0);

    await addExpense(page, "50", "— Fuel");
    await expect
      .poll(async () => (await emailsTo(page, signedInUser.username)).length)
      .toBe(1);
    const [email] = await emailsTo(page, signedInUser.username);
    expect(email.subject).toBe("Budget exceeded: Transport — Finance Tracker");
    expect(email.text).toContain("110.00 PLN");
    expect(email.text).toContain("100.00 PLN");

    await addExpense(page, "30", "— Fuel");
    expect(await emailsTo(page, signedInUser.username)).toHaveLength(1);
  });

  test("is sent when a new budget is already below this month's spending", async ({
    page,
    signedInUser,
  }) => {
    await addExpense(page, "80", "Health");
    await addBudget(page, "Health", "50");

    await expect
      .poll(async () => (await emailsTo(page, signedInUser.username)).length)
      .toBe(1);
  });

  test("is sent when a limit is lowered below this month's spending", async ({
    page,
    signedInUser,
  }) => {
    await addBudget(page, "Shopping", "500");
    await addExpense(page, "200", "— Clothing");
    expect(await emailsTo(page, signedInUser.username)).toHaveLength(0);

    await page.goto("/budgets");
    await page
      .getByTestId("budget-row")
      .filter({ hasText: "Shopping" })
      .getByTestId("edit-budget")
      .click();
    const dialog = page.getByTestId("budget-dialog");
    await dialog.getByLabel(/Monthly limit/).fill("150");
    await dialog.getByRole("button", { name: "Save Changes" }).click();
    await expect(dialog).toBeHidden();

    await expect
      .poll(async () => (await emailsTo(page, signedInUser.username)).length)
      .toBe(1);
  });

  test("is sent when a CSV import goes over", async ({ page, signedInUser }) => {
    await addBudget(page, "Groceries", "10");

    // One row dated today, which the seeded BIEDRONKA rule files under
    // Groceries.
    const csv = test.info().outputPath("current-month.csv");
    writeFileSync(
      csv,
      `Date,Amount,Description,Category\n${todayUtc()},-45.99,BIEDRONKA 1234 WROCLAW,\n`,
    );

    await page.goto("/dashboard");
    await page.getByRole("link", { name: "Import" }).click();
    await expect(page.getByRole("button", { name: "Choose File" })).toBeVisible();
    await page.locator('input[type="file"][accept=".csv"]').setInputFiles(csv);
    await expect(page.getByRole("combobox", { name: "Date" })).toBeVisible();
    await page.getByRole("button", { name: "Continue" }).click();
    await page
      .getByRole("combobox", { name: "Account" })
      .selectOption({ label: "Main (PLN)" });
    await page.getByRole("button", { name: "Continue" }).click();
    await page.getByRole("button", { name: "Confirm Import" }).click();
    await expect(
      page.getByRole("heading", { name: "Import complete" }),
    ).toBeVisible();

    await expect
      .poll(async () => (await emailsTo(page, signedInUser.username)).length)
      .toBe(1);
    const [email] = await emailsTo(page, signedInUser.username);
    expect(email.text).toContain("45.99 PLN");
  });
});
