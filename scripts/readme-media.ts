// scripts/readme-media.ts — regenerates the README screenshots and the
// add-budget GIF in docs/screenshots/.
//
// Usage:
//   pnpm run seed:demo --reset   # with the dev server stopped
//   pnpm run dev                 # in another terminal
//   pnpm run readme:media
//
// Drives the running dev server as the demo user with Playwright. It changes
// the demo data (removes the Transport budget, adds one on Groceries › Fruits),
// so reseed before running it again. Needs ffmpeg on PATH for the GIF
// (Playwright's bundled ffmpeg only encodes WebM).

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Page } from "playwright";

const BASE_URL = process.env.BASE_URL ?? "http://127.0.0.1:3000";
const OUT = "docs/screenshots";
const DESKTOP = { width: 1280, height: 800 };

mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch();

// The dev server keeps connections open (hot reload), so "networkidle" never
// arrives: wait for the page's data instead.
async function settle(page: Page) {
  await page.waitForLoadState("load");
  await page.waitForFunction(
    () =>
      !document.body.innerText.includes("Loading...") &&
      document.querySelector("main") !== null,
  );
  await page.waitForTimeout(500);
}

// --- Screenshots -----------------------------------------------------------

const context = await browser.newContext({ baseURL: BASE_URL, viewport: DESKTOP });
const page = await context.newPage();
await page.goto("/login");
await page.getByLabel("Email or username").fill("demo@example.com");
await page.getByLabel("Password").fill("demo-password");
await page.getByRole("button", { name: "Sign in" }).click();
await page.waitForURL("**/dashboard");

// Budgets page: over / near / under budgets, at the Free plan limit.
await page.goto("/budgets");
await settle(page);
await page.screenshot({ path: `${OUT}/budgets.png` });

// Dashboard: the budgets section below the spending overview.
await page.goto("/dashboard");
await settle(page);
await page
  .locator('section[aria-labelledby="dashboard-budgets-title"]')
  .screenshot({ path: `${OUT}/dashboard-budgets.png` });

// Phone width.
await page.setViewportSize({ width: 390, height: 844 });
await page.goto("/budgets");
await settle(page);
await page.screenshot({ path: `${OUT}/budgets-mobile.png` });
await page.setViewportSize(DESKTOP);

// Free up a slot (the demo user is on the Free plan with 3 budgets), then
// show the add dialog with the parent-budget warning.
await page.goto("/budgets");
await settle(page);
await page
  .getByTestId("budget-row")
  .filter({ hasText: "Transport" })
  .getByTestId("delete-budget")
  .click();
await page.getByTestId("delete-budget-confirm").click();
await page.getByTestId("delete-budget-dialog").waitFor({ state: "hidden" });
await page.getByRole("button", { name: "Add Budget" }).click();
const dialog = page.getByTestId("budget-dialog");
await dialog.getByLabel("Category").selectOption({ label: "Groceries › Fruits" });
await dialog.getByLabel(/Monthly limit/).fill("600");
await dialog.getByTestId("budget-hierarchy-warning").waitFor();
await page.waitForTimeout(300);
await page.screenshot({ path: `${OUT}/add-budget-dialog.png` });
await dialog.getByRole("button", { name: "Cancel" }).click();

const storageState = await context.storageState();
await context.close();

// --- GIF: adding a budget --------------------------------------------------

const videoDir = mkdtempSync(join(tmpdir(), "readme-media-"));
const video = await browser.newContext({
  baseURL: BASE_URL,
  viewport: DESKTOP,
  storageState,
  recordVideo: { dir: videoDir, size: DESKTOP },
});
const v = await video.newPage();
await v.goto("/budgets");
await settle(v);
await v.waitForTimeout(800);
await v.getByRole("button", { name: "Add Budget" }).click();
await v.waitForTimeout(600);
const d = v.getByTestId("budget-dialog");
await d.getByLabel("Category").selectOption({ label: "Groceries › Fruits" });
await v.waitForTimeout(600);
const limit = d.getByLabel(/Monthly limit/);
await limit.pressSequentially("600", { delay: 180 });
await v.waitForTimeout(1600); // the parent-budget warning
await limit.fill("");
await limit.pressSequentially("40", { delay: 180 });
await v.waitForTimeout(900);
await d.getByRole("button", { name: "Create Budget" }).click();
await d.waitFor({ state: "hidden" });
await v.waitForTimeout(2200); // the new budget, already over
await video.close(); // finalizes the WebM

const webm = readdirSync(videoDir)
  .filter((f) => f.endsWith(".webm"))
  .map((f) => join(videoDir, f))
  .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0];
execFileSync(
  "ffmpeg",
  [
    "-y",
    "-loglevel", "error",
    "-ss", "0.6",
    "-i", webm,
    "-vf",
    // A full 256-color palette keeps small UI colors (category dots) intact.
    "fps=10,scale=960:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=256:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle",
    "-loop", "0",
    `${OUT}/add-budget.gif`,
  ],
  { stdio: "inherit" },
);

await browser.close();
for (const f of readdirSync(OUT).sort()) {
  console.log(`${OUT}/${f}  ${Math.round(statSync(join(OUT, f)).size / 1024)} KB`);
}
