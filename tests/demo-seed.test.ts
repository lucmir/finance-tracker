// @vitest-environment node
// Required: TanStack Start's import protection mocks server modules in jsdom (client) environment.

import bcrypt from "bcryptjs";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db, schema } from "../src/db/index.ts";
import { hardDeleteUser } from "../src/server/compliance.server.ts";
import {
  DEMO_EMAIL,
  DEMO_PASSWORD,
  DemoUserExistsError,
  seedDemo,
  type DemoSeedResult,
} from "../src/server/demo-seed.server.ts";

const NOW = new Date("2026-03-10T12:00:00Z");

const transactionsOf = (userId: string) =>
  db
    .select({
      date: schema.transactions.date,
      amount_minor: schema.transactions.amount_minor,
      category_id: schema.transactions.category_id,
    })
    .from(schema.transactions)
    .where(eq(schema.transactions.user_id, userId));

const categoriesOf = (userId: string) =>
  db
    .select({
      id: schema.categories.id,
      name: schema.categories.name,
      parent_id: schema.categories.parent_id,
    })
    .from(schema.categories)
    .where(eq(schema.categories.user_id, userId));

describe("demo seed", () => {
  let result: DemoSeedResult;

  beforeAll(async () => {
    result = await seedDemo({ now: NOW });
  });

  afterAll(async () => {
    const [demo] = await db
      .select({ id: schema.users.id })
      .from(schema.users)
      .where(eq(schema.users.email, DEMO_EMAIL));
    if (demo) await hardDeleteUser(demo.id);
  });

  it("creates a verified demo user that can log in", async () => {
    const [user] = await db
      .select()
      .from(schema.users)
      .where(eq(schema.users.id, result.userId));
    expect(user.email).toBe(DEMO_EMAIL);
    expect(user.email_verified_at).not.toBeNull();
    expect(await bcrypt.compare(DEMO_PASSWORD, user.password_hash)).toBe(true);
  });

  it("covers the two previous months and the current month up to today", async () => {
    const dates = (await transactionsOf(result.userId)).map((t) => t.date).sort();
    expect(dates.length).toBe(result.transactions);
    expect(dates[0]).toBe("2026-01-01");
    expect(dates[dates.length - 1] <= "2026-03-10").toBe(true);
    // Month boundaries: last day of the previous month and first of this one.
    expect(dates).toContain("2026-02-28");
    expect(dates).toContain("2026-03-01");
    expect(result.dateRange).toEqual([dates[0], dates[dates.length - 1]]);
  });

  it("includes a refund, uncategorized expenses and a third-level category", async () => {
    const txs = await transactionsOf(result.userId);
    const categories = await categoriesOf(result.userId);
    const byId = new Map(categories.map((c) => [c.id, c]));

    const clothing = categories.find((c) => c.name === "Clothing")!;
    const refunds = txs.filter(
      (t) => t.category_id === clothing.id && t.amount_minor > 0,
    );
    expect(refunds).toHaveLength(1);
    expect(refunds[0].date.startsWith("2026-03")).toBe(true);

    expect(
      txs.filter((t) => t.category_id === null && t.amount_minor < 0).length,
    ).toBeGreaterThan(0);

    const coffee = categories.find((c) => c.name === "Coffee")!;
    const diningOut = byId.get(coffee.parent_id!)!;
    expect(diningOut.name).toBe("Dining Out");
    expect(byId.get(diningOut.parent_id!)!.name).toBe("Entertainment");
    expect(txs.some((t) => t.category_id === coffee.id)).toBe(true);
  });

  it("adds three sample budgets on top-level categories", async () => {
    const budgets = await db
      .select({
        limit_minor: schema.budgets.limit_minor,
        name: schema.categories.name,
      })
      .from(schema.budgets)
      .innerJoin(
        schema.categories,
        eq(schema.budgets.category_id, schema.categories.id),
      )
      .where(eq(schema.budgets.user_id, result.userId));
    expect(result.budgets).toBe(3);
    expect(
      Object.fromEntries(budgets.map((b) => [b.name, b.limit_minor])),
    ).toEqual({ Groceries: 40000, Entertainment: 25000, Transport: 50000 });
  });

  it("refuses to run again without reset", async () => {
    await expect(seedDemo({ now: NOW })).rejects.toBeInstanceOf(
      DemoUserExistsError,
    );
  });

  it("reset replaces only the demo user", async () => {
    const bystanderId = "demo-seed-bystander";
    await db.insert(schema.users).values({
      id: bystanderId,
      username: bystanderId,
      password_hash: "x",
    });
    await db.insert(schema.categories).values({
      id: `${bystanderId}-cat`,
      user_id: bystanderId,
      name: "Bystander category",
    });

    const second = await seedDemo({ reset: true, now: NOW });

    expect(second.userId).not.toBe(result.userId);
    expect(second.transactions).toBe(result.transactions);
    expect(await transactionsOf(result.userId)).toHaveLength(0);
    expect(await categoriesOf(bystanderId)).toHaveLength(1);

    await hardDeleteUser(bystanderId);
    result = second;
  });

  it("never dates transactions in the future early in the month", async () => {
    const early = await seedDemo({
      reset: true,
      now: new Date("2026-03-02T08:00:00Z"),
    });
    const dates = (await transactionsOf(early.userId)).map((t) => t.date);
    expect(dates.every((d) => d <= "2026-03-02")).toBe(true);
    expect(dates.filter((d) => d.startsWith("2026-03")).length).toBeGreaterThan(0);
    result = early;
  });
});
