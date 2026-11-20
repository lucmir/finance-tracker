import { and, eq, inArray, isNotNull } from "drizzle-orm";
import { db, schema } from "#/db";
import { formatMinor } from "#/lib/money";
import { m } from "#/paraglide/messages";
import { budgetMonth, listBudgets } from "#/server/budgets.server";
import { sendEmail, type EmailMessage } from "#/server/email";
import { env } from "#/server/env";
import { getLogger } from "#/server/logger";

//
// Over-budget emails (T7): at most one per budget per calendar month (UTC).
//
// `checkBudgetAlerts` is idempotent and cheap when nothing is over, so it can
// run after every change that may move spending (decision D1): the
// `budgetAlertsAfter` middleware on the spending server functions, the end of
// the CSV import stream, and the hourly sweep as a backstop.
//
// At most once: the alert row is inserted before sending, and the unique
// (budget_id, month) constraint lets only one concurrent check win. If
// sending fails, the row is removed so a later check retries. A crash
// between insert and send loses that month's email; a duplicate email is the
// worse failure.

export interface AlertCheckResult {
  /** Emails sent by this check. */
  sent: number;
  /** Over-budget budgets skipped because the user has no verified email. */
  skippedUnverified: number;
}

type Send = (message: EmailMessage) => Promise<void>;

const money = (minor: number) => `${formatMinor(minor)} ${m.analytics_currency()}`;

export async function checkBudgetAlerts(
  userId: string,
  now: Date = new Date(),
  send: Send = sendEmail,
): Promise<AlertCheckResult> {
  const budgets = (await listBudgets(userId, now)).filter((b) => b.over);
  if (budgets.length === 0) return { sent: 0, skippedUnverified: 0 };

  const [user] = await db
    .select({
      email: schema.users.email,
      email_verified_at: schema.users.email_verified_at,
    })
    .from(schema.users)
    .where(eq(schema.users.id, userId))
    .limit(1);
  // Decision D6: verified addresses only. Nothing is recorded, so the user
  // still gets the email later this month once they verify.
  if (!user?.email || !user.email_verified_at) {
    return { sent: 0, skippedUnverified: budgets.length };
  }

  const { month } = budgetMonth(now);
  const alreadySent = new Set(
    (
      await db
        .select({ budget_id: schema.budget_alerts.budget_id })
        .from(schema.budget_alerts)
        .where(
          and(
            eq(schema.budget_alerts.user_id, userId),
            eq(schema.budget_alerts.month, month),
            inArray(
              schema.budget_alerts.budget_id,
              budgets.map((b) => b.id),
            ),
          ),
        )
    ).map((r) => r.budget_id),
  );

  let sent = 0;
  for (const budget of budgets) {
    if (alreadySent.has(budget.id)) continue;

    const alertId = crypto.randomUUID();
    const claimed = await db
      .insert(schema.budget_alerts)
      .values({ id: alertId, budget_id: budget.id, user_id: userId, month })
      .onConflictDoNothing({
        target: [schema.budget_alerts.budget_id, schema.budget_alerts.month],
      })
      .returning({ id: schema.budget_alerts.id });
    // Another check claimed this budget for the month first.
    if (claimed.length === 0) continue;

    const category = budget.category_path.join(" › ");
    try {
      await send({
        to: user.email,
        subject: m.email_budget_exceeded_subject({ category }),
        text: m.email_budget_exceeded_body({
          category,
          spent: money(budget.spent_minor),
          limit: money(budget.limit_minor),
          link: `${env.email.baseUrl}/budgets`,
        }),
      });
      sent++;
    } catch (error) {
      await db
        .delete(schema.budget_alerts)
        .where(eq(schema.budget_alerts.id, alertId));
      getLogger().error(
        { err: error, userId, budgetId: budget.id },
        "failed to send over-budget email; will retry on the next check",
      );
    }
  }
  return { sent, skippedUnverified: 0 };
}

/**
 * Runs the check after a request has changed spending. Never throws: a
 * failed email or query must not fail the user's save.
 */
export async function checkBudgetAlertsSafely(userId: string): Promise<void> {
  try {
    await checkBudgetAlerts(userId);
  } catch (error) {
    getLogger().error({ err: error, userId }, "budget alert check failed");
  }
}

/**
 * Hourly backstop: checks every user with a verified email and at least one
 * budget, catching changes that bypassed the request-time check.
 */
export async function runBudgetAlertSweep(now: Date = new Date()): Promise<{
  usersChecked: number;
  alertsSent: number;
}> {
  const users = await db
    .selectDistinct({ id: schema.budgets.user_id })
    .from(schema.budgets)
    .innerJoin(schema.users, eq(schema.users.id, schema.budgets.user_id))
    .where(isNotNull(schema.users.email_verified_at));

  let alertsSent = 0;
  for (const { id } of users) {
    try {
      alertsSent += (await checkBudgetAlerts(id, now)).sent;
    } catch (error) {
      getLogger().error({ err: error, userId: id }, "budget alert sweep failed for user");
    }
  }
  if (alertsSent > 0) {
    getLogger().info({ alertsSent }, "budget alert sweep sent emails");
  }
  return { usersChecked: users.length, alertsSent };
}
