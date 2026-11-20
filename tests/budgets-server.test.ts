// @vitest-environment node
// Required: TanStack Start's import protection mocks server modules in jsdom (client) environment.

import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { db, schema } from "../src/db/index.ts";
import { deleteBudgetsForCategories } from "../src/server/budgets.server.ts";
import { hardDeleteUser } from "../src/server/compliance.server.ts";

const USER = "budgets-test-user";
const OTHER = "budgets-test-other";

async function seedUser(userId: string, categoryNames: string[]) {
  await db.insert(schema.users).values({
    id: userId,
    username: userId,
    password_hash: "x",
  });
  for (const name of categoryNames) {
    await db.insert(schema.categories).values({
      id: `${userId}-${name}`,
      user_id: userId,
      name,
    });
  }
}

async function addBudget(userId: string, category: string, withAlert = false) {
  const id = `${userId}-${category}-budget`;
  await db.insert(schema.budgets).values({
    id,
    user_id: userId,
    category_id: `${userId}-${category}`,
    limit_minor: 10000,
  });
  if (withAlert) {
    await db.insert(schema.budget_alerts).values({
      id: `${id}-alert`,
      budget_id: id,
      user_id: userId,
      month: "2026-11",
    });
  }
  return id;
}

const budgetsOf = (userId: string) =>
  db
    .select({ id: schema.budgets.id })
    .from(schema.budgets)
    .where(eq(schema.budgets.user_id, userId));

const alertsOf = (userId: string) =>
  db
    .select({ id: schema.budget_alerts.id })
    .from(schema.budget_alerts)
    .where(eq(schema.budget_alerts.user_id, userId));

describe("budgets schema", () => {
  beforeEach(() => seedUser(USER, ["food", "fuel"]));
  afterEach(() => hardDeleteUser(USER));

  it("allows one budget per category", async () => {
    await addBudget(USER, "food");
    await expect(addBudget(USER, "food")).rejects.toThrow();
  });

  it("rejects a zero or negative limit", async () => {
    for (const limit_minor of [0, -100]) {
      await expect(
        db.insert(schema.budgets).values({
          id: `${USER}-bad-${limit_minor}`,
          user_id: USER,
          category_id: `${USER}-food`,
          limit_minor,
        }),
      ).rejects.toThrow();
    }
  });

  it("allows one alert per budget per month", async () => {
    const budgetId = await addBudget(USER, "food", true);
    await expect(
      db.insert(schema.budget_alerts).values({
        id: `${budgetId}-alert-2`,
        budget_id: budgetId,
        user_id: USER,
        month: "2026-11",
      }),
    ).rejects.toThrow();
    // A new month is a new alert.
    await db.insert(schema.budget_alerts).values({
      id: `${budgetId}-alert-dec`,
      budget_id: budgetId,
      user_id: USER,
      month: "2026-12",
    });
    expect(await alertsOf(USER)).toHaveLength(2);
  });
});

describe("deleteBudgetsForCategories", () => {
  beforeEach(async () => {
    await seedUser(USER, ["food", "fuel"]);
    await seedUser(OTHER, ["food"]);
  });
  afterEach(async () => {
    await hardDeleteUser(USER);
    await hardDeleteUser(OTHER);
  });

  it("deletes the budgets on the given categories and their alerts", async () => {
    await addBudget(USER, "food", true);
    const fuelBudget = await addBudget(USER, "fuel", true);

    const deleted = await deleteBudgetsForCategories(USER, [`${USER}-food`]);

    expect(deleted).toBe(1);
    expect(await budgetsOf(USER)).toEqual([{ id: fuelBudget }]);
    expect(await alertsOf(USER)).toEqual([{ id: `${fuelBudget}-alert` }]);
  });

  it("never touches another user's budgets, even with their category ids", async () => {
    const otherBudget = await addBudget(OTHER, "food", true);

    const deleted = await deleteBudgetsForCategories(USER, [`${OTHER}-food`]);

    expect(deleted).toBe(0);
    expect(await budgetsOf(OTHER)).toEqual([{ id: otherBudget }]);
    expect(await alertsOf(OTHER)).toHaveLength(1);
  });

  it("does nothing for an empty list", async () => {
    await addBudget(USER, "food");
    expect(await deleteBudgetsForCategories(USER, [])).toBe(0);
    expect(await budgetsOf(USER)).toHaveLength(1);
  });
});
