// @vitest-environment node
// Required: TanStack Start's import protection mocks server modules in jsdom (client) environment.

import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { db, schema } from "../src/db/index.ts";
import {
  checkBudgetAlerts,
  runBudgetAlertSweep,
} from "../src/server/budget-alerts.server.ts";
import { createBudget } from "../src/server/budgets.server.ts";
import { hardDeleteUser } from "../src/server/compliance.server.ts";
import { getCapturedEmails } from "../src/server/email.ts";

// T7: an email when a budget goes over, at most once per budget per month
// (decisions D1, D5, D6).
const NOV = new Date("2026-11-15T12:00:00Z");
const DEC = new Date("2026-12-03T12:00:00Z");

const created: string[] = [];
let seq = 0;

async function seedUser(opts: { email?: "verified" | "unverified" | "none" } = {}) {
  const id = `alerts-user-${++seq}`;
  const email = opts.email === "none" ? null : `${id}@example.com`;
  await db.insert(schema.users).values({
    id,
    username: id,
    email,
    email_verified_at: opts.email === "unverified" ? null : new Date(),
    password_hash: "x",
  });
  await db.insert(schema.accounts).values({ id: `${id}-acc`, user_id: id, name: "Main" });
  for (const name of ["food", "fuel"]) {
    await db
      .insert(schema.categories)
      .values({ id: `${id}-${name}`, user_id: id, name });
  }
  created.push(id);
  return { id, email: email ?? "" };
}

async function spend(userId: string, category: string, date: string, minor: number) {
  await db.insert(schema.transactions).values({
    id: crypto.randomUUID(),
    user_id: userId,
    account_id: `${userId}-acc`,
    date,
    amount_minor: -minor,
    category_id: `${userId}-${category}`,
  });
}

async function budget(userId: string, category: string, limitMinor: number) {
  const result = await createBudget(userId, {
    categoryId: `${userId}-${category}`,
    limitMinor,
  });
  if (!("id" in result)) throw new Error(result.error);
  return result.id;
}

const alertsOf = (userId: string) =>
  db.select().from(schema.budget_alerts).where(eq(schema.budget_alerts.user_id, userId));

afterEach(async () => {
  for (const id of created.splice(0)) await hardDeleteUser(id);
});

describe("checkBudgetAlerts", () => {
  it("emails once when a budget goes over, with the details", async () => {
    const user = await seedUser();
    await budget(user.id, "food", 10000);
    await spend(user.id, "food", "2026-11-10", 12550);

    expect(await checkBudgetAlerts(user.id, NOV)).toEqual({ sent: 1, skippedUnverified: 0 });

    const emails = getCapturedEmails(user.email);
    expect(emails).toHaveLength(1);
    expect(emails[0].subject).toContain("Budget exceeded: food");
    expect(emails[0].text).toContain("125.50 PLN");
    expect(emails[0].text).toContain("100.00 PLN");
    expect(emails[0].text).toMatch(/https?:\/\/[^\s]+\/budgets/);
    expect(await alertsOf(user.id)).toMatchObject([{ month: "2026-11" }]);
  });

  it("sends nothing more that month, even as spending grows", async () => {
    const user = await seedUser();
    await budget(user.id, "food", 10000);
    await spend(user.id, "food", "2026-11-10", 12000);
    await checkBudgetAlerts(user.id, NOV);
    await spend(user.id, "food", "2026-11-11", 5000);

    expect((await checkBudgetAlerts(user.id, NOV)).sent).toBe(0);
    expect(getCapturedEmails(user.email)).toHaveLength(1);
  });

  it("emails again when the budget goes over in a new month", async () => {
    const user = await seedUser();
    await budget(user.id, "food", 10000);
    await spend(user.id, "food", "2026-11-10", 12000);
    await checkBudgetAlerts(user.id, NOV);
    await spend(user.id, "food", "2026-12-02", 10001);

    expect((await checkBudgetAlerts(user.id, DEC)).sent).toBe(1);
    expect(getCapturedEmails(user.email)).toHaveLength(2);
    expect((await alertsOf(user.id)).map((a) => a.month).sort()).toEqual([
      "2026-11",
      "2026-12",
    ]);
  });

  it("sends nothing under or exactly at the limit (D5)", async () => {
    const user = await seedUser();
    await budget(user.id, "food", 10000);
    await spend(user.id, "food", "2026-11-10", 10000);

    expect((await checkBudgetAlerts(user.id, NOV)).sent).toBe(0);
    expect(getCapturedEmails(user.email)).toHaveLength(0);
    expect(await alertsOf(user.id)).toHaveLength(0);
  });

  it("emails each over-budget budget separately", async () => {
    const user = await seedUser();
    await budget(user.id, "food", 100);
    await budget(user.id, "fuel", 100);
    await spend(user.id, "food", "2026-11-10", 200);
    await spend(user.id, "fuel", "2026-11-10", 200);

    expect((await checkBudgetAlerts(user.id, NOV)).sent).toBe(2);
    expect(getCapturedEmails(user.email).map((e) => e.subject).sort()).toEqual([
      "Budget exceeded: food — Finance Tracker",
      "Budget exceeded: fuel — Finance Tracker",
    ]);
  });

  it("skips unverified emails without marking them, so verifying later still gets the email (D6)", async () => {
    const user = await seedUser({ email: "unverified" });
    await budget(user.id, "food", 100);
    await spend(user.id, "food", "2026-11-10", 200);

    expect(await checkBudgetAlerts(user.id, NOV)).toEqual({ sent: 0, skippedUnverified: 1 });
    expect(getCapturedEmails(user.email)).toHaveLength(0);
    expect(await alertsOf(user.id)).toHaveLength(0);

    await db
      .update(schema.users)
      .set({ email_verified_at: new Date() })
      .where(eq(schema.users.id, user.id));
    expect((await checkBudgetAlerts(user.id, NOV)).sent).toBe(1);
  });

  it("skips users without an email address", async () => {
    const user = await seedUser({ email: "none" });
    await budget(user.id, "food", 100);
    await spend(user.id, "food", "2026-11-10", 200);

    expect((await checkBudgetAlerts(user.id, NOV)).sent).toBe(0);
    expect(await alertsOf(user.id)).toHaveLength(0);
  });

  it("releases the claim when sending fails, so the next check retries", async () => {
    const user = await seedUser();
    await budget(user.id, "food", 100);
    await spend(user.id, "food", "2026-11-10", 200);
    const failingSend = async () => {
      throw new Error("provider down");
    };

    expect((await checkBudgetAlerts(user.id, NOV, failingSend)).sent).toBe(0);
    expect(await alertsOf(user.id)).toHaveLength(0);

    expect((await checkBudgetAlerts(user.id, NOV)).sent).toBe(1);
    expect(getCapturedEmails(user.email)).toHaveLength(1);
  });

  it("sends once when several checks run at the same time", async () => {
    const user = await seedUser();
    await budget(user.id, "food", 100);
    await spend(user.id, "food", "2026-11-10", 200);

    const results = await Promise.all(
      Array.from({ length: 5 }, () => checkBudgetAlerts(user.id, NOV)),
    );

    expect(results.reduce((n, r) => n + r.sent, 0)).toBe(1);
    expect(getCapturedEmails(user.email)).toHaveLength(1);
    expect(await alertsOf(user.id)).toHaveLength(1);
  });
});

describe("runBudgetAlertSweep", () => {
  it("catches over-budget users missed at request time", async () => {
    const over = await seedUser();
    const under = await seedUser();
    await budget(over.id, "food", 100);
    await spend(over.id, "food", "2026-11-10", 200);
    await budget(under.id, "food", 100000);

    const result = await runBudgetAlertSweep(NOV);

    expect(result.alertsSent).toBeGreaterThanOrEqual(1);
    expect(getCapturedEmails(over.email)).toHaveLength(1);
    expect(getCapturedEmails(under.email)).toHaveLength(0);

    // A second pass sends nothing new.
    await runBudgetAlertSweep(NOV);
    expect(getCapturedEmails(over.email)).toHaveLength(1);
  });
});
