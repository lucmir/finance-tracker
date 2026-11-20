// @vitest-environment node
// Required: TanStack Start's import protection mocks server modules in jsdom (client) environment.

import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { db, schema } from "../src/db/index.ts";
import {
  budgetMonth,
  createBudget,
  listBudgets,
} from "../src/server/budgets.server.ts";
import { hardDeleteUser } from "../src/server/compliance.server.ts";

// The spec for "spent this month" (T3–T6, decisions D2, D3, D5).
//
// Categories for USER:  food › snacks › candy,  fuel,  income
// Categories for OTHER: food
const USER = "progress-user";
const OTHER = "progress-other";
const NOW = new Date("2026-11-15T12:00:00Z");

let txSeq = 0;
async function tx(
  userId: string,
  category: string | null,
  date: string,
  amountMinor: number,
  source = "manual",
) {
  await db.insert(schema.transactions).values({
    id: `${userId}-tx-${++txSeq}`,
    user_id: userId,
    account_id: `${userId}-acc`,
    date,
    amount_minor: amountMinor,
    category_id: category ? `${userId}-${category}` : null,
    source,
  });
}

async function seedUser(userId: string, categories: [string, string | null][]) {
  await db.insert(schema.users).values({
    id: userId,
    username: userId,
    password_hash: "x",
  });
  await db.insert(schema.accounts).values({
    id: `${userId}-acc`,
    user_id: userId,
    name: "Main",
  });
  for (const [name, parent] of categories) {
    await db.insert(schema.categories).values({
      id: `${userId}-${name}`,
      user_id: userId,
      name,
      parent_id: parent ? `${userId}-${parent}` : null,
    });
  }
}

async function budgetOn(category: string, limitMinor: number) {
  const result = await createBudget(USER, {
    categoryId: `${USER}-${category}`,
    limitMinor,
  });
  if (!("id" in result)) throw new Error(result.error);
}

async function progressOf(category: string, now = NOW) {
  const row = (await listBudgets(USER, now)).find(
    (b) => b.category_id === `${USER}-${category}`,
  );
  if (!row) throw new Error(`no budget on ${category}`);
  return row;
}

beforeEach(async () => {
  await seedUser(USER, [
    ["food", null],
    ["snacks", "food"],
    ["candy", "snacks"],
    ["fuel", null],
    ["income", null],
  ]);
  await seedUser(OTHER, [["food", null]]);
});

afterEach(async () => {
  await hardDeleteUser(USER);
  await hardDeleteUser(OTHER);
});

describe("budgetMonth (UTC calendar month, D3)", () => {
  it("returns the month and its bounds", () => {
    expect(budgetMonth(NOW)).toEqual({
      month: "2026-11",
      start: "2026-11-01",
      end: "2026-12-01",
    });
  });

  it("uses UTC at the year boundary", () => {
    expect(budgetMonth(new Date("2026-12-31T23:59:59Z"))).toEqual({
      month: "2026-12",
      start: "2026-12-01",
      end: "2027-01-01",
    });
    expect(budgetMonth(new Date("2027-01-01T00:00:00Z")).month).toBe("2027-01");
    // 21:30 on Dec 31 in UTC−3 is already January in UTC.
    expect(budgetMonth(new Date("2026-12-31T21:30:00-03:00")).month).toBe("2027-01");
  });
});

describe("spent this month", () => {
  it("is 0 for a budget without spending", async () => {
    await budgetOn("food", 10000);
    expect(await progressOf("food")).toMatchObject({
      spent_minor: 0,
      left_minor: 10000,
      over: false,
    });
  });

  it("includes every subcategory, at any depth (T4)", async () => {
    await budgetOn("food", 100000);
    await tx(USER, "food", "2026-11-03", -1000);
    await tx(USER, "snacks", "2026-11-04", -200);
    await tx(USER, "candy", "2026-11-05", -30);
    expect((await progressOf("food")).spent_minor).toBe(1230);
  });

  it("counts only a subcategory's own subtree for its budget", async () => {
    await budgetOn("food", 100000);
    await budgetOn("snacks", 100000);
    await tx(USER, "food", "2026-11-03", -1000);
    await tx(USER, "snacks", "2026-11-04", -200);
    await tx(USER, "candy", "2026-11-05", -30);
    expect((await progressOf("snacks")).spent_minor).toBe(230);
    expect((await progressOf("food")).spent_minor).toBe(1230);
  });

  it("ignores income and refunds (T5)", async () => {
    await budgetOn("food", 100000);
    await tx(USER, "food", "2026-11-03", -1000);
    await tx(USER, "food", "2026-11-04", 400); // refund
    await tx(USER, "candy", "2026-11-05", 50); // refund in a subcategory
    expect((await progressOf("food")).spent_minor).toBe(1000);
  });

  it("ignores sibling categories, uncategorized spending and other users", async () => {
    await budgetOn("food", 100000);
    await tx(USER, "fuel", "2026-11-03", -5000);
    await tx(USER, null, "2026-11-03", -700);
    await tx(OTHER, "food", "2026-11-03", -9000);
    expect((await progressOf("food")).spent_minor).toBe(0);
  });

  it("counts only the current month, first and last day included (T6)", async () => {
    await budgetOn("food", 100000);
    await tx(USER, "food", "2026-10-31", -1); // previous month
    await tx(USER, "food", "2026-11-01", -10); // first day
    await tx(USER, "food", "2026-11-30", -100); // last day
    await tx(USER, "food", "2026-12-01", -1000); // next month
    expect((await progressOf("food")).spent_minor).toBe(110);
  });

  it("resets when the month changes", async () => {
    await budgetOn("food", 100000);
    await tx(USER, "food", "2026-11-20", -500);
    await tx(USER, "food", "2026-12-02", -70);
    expect((await progressOf("food", NOW)).spent_minor).toBe(500);
    expect(
      (await progressOf("food", new Date("2026-12-05T00:00:00Z"))).spent_minor,
    ).toBe(70);
  });

  it("counts scanned receipts (stored as expenses since S1)", async () => {
    await budgetOn("food", 100000);
    await tx(USER, "food", "2026-11-03", -3699, "receipt");
    expect((await progressOf("food")).spent_minor).toBe(3699);
  });

  it("is over only when spent exceeds the limit (D5)", async () => {
    await budgetOn("food", 1230);
    await budgetOn("snacks", 229);
    await tx(USER, "food", "2026-11-03", -1000);
    await tx(USER, "snacks", "2026-11-04", -230);

    expect(await progressOf("food")).toMatchObject({
      spent_minor: 1230,
      left_minor: 0,
      over: false,
    });
    expect(await progressOf("snacks")).toMatchObject({
      spent_minor: 230,
      left_minor: -1,
      over: true,
    });
  });

  it("terminates on a cycle in the category tree", async () => {
    // food → candy → snacks → food (parent_id has no FK or cycle check in SQL)
    await db
      .update(schema.categories)
      .set({ parent_id: `${USER}-candy` })
      .where(eq(schema.categories.id, `${USER}-food`));
    await budgetOn("food", 100000);
    await tx(USER, "candy", "2026-11-03", -300);
    expect((await progressOf("food")).spent_minor).toBe(300);
  });
});
