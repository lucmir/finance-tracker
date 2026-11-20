import { runBudgetAlertSweep } from "#/server/budget-alerts.server";
import { runComplianceSweep } from "#/server/compliance.server";
import { env } from "#/server/env";
import { getLogger } from "#/server/logger";

//
// In-process scheduler for the hourly sweeps (compliance and over-budget
// alerts). There is no external job runner — the loop is armed lazily by the
// first request (see start.ts) and re-runs hourly. TEST_MODE never arms it:
// E2E tests trigger the sweeps deterministically through /test-run-sweep.

const SWEEP_INTERVAL_MS = 60 * 60 * 1000;

let armed = false;

export function ensureMaintenanceLoop(): void {
  if (armed) return;
  armed = true;
  if (env.isTestMode) return;

  // Independent passes: one failing never skips the other.
  const sweep = () =>
    Promise.all([
      runComplianceSweep().catch((error) =>
        getLogger().error({ err: error }, "compliance sweep failed"),
      ),
      // Backstop for over-budget emails (decision D1).
      runBudgetAlertSweep().catch((error) =>
        getLogger().error({ err: error }, "budget alert sweep failed"),
      ),
    ]);
  void sweep();
  // unref: the timer must never keep a shutting-down server process alive.
  setInterval(sweep, SWEEP_INTERVAL_MS).unref();
}
