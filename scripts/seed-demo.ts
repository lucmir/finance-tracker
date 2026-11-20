// scripts/seed-demo.ts — creates the demo user and demo data in the local
// database. Logic lives in src/server/demo-seed.server.ts.
//
// Usage: pnpm run seed:demo [--reset]
//
// Writes to the database selected by the environment (DATABASE_URL →
// Postgres, otherwise the local PGlite instance at ./data/pg). PGlite allows
// one process per data directory, so stop the dev server first.

import net from "node:net";

const reset = process.argv.includes("--reset");

function isPortInUse(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host: "127.0.0.1", port });
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
  });
}

// TEST_MODE uses an in-memory database, so there is nothing to conflict with.
const usesLocalPglite = !process.env.DATABASE_URL && process.env.TEST_MODE !== "1";
if (usesLocalPglite && (await isPortInUse(3000))) {
  console.error(
    "[seed:demo] Something is running on port 3000 (probably the dev server).\n" +
      "[seed:demo] Stop it first: the local PGlite database can only be opened by one process.",
  );
  process.exit(1);
}

// Keep the output to the summary below; server modules log at info level.
process.env.LOG_LEVEL ??= "warn";

// Imported after the checks above: importing it opens the database.
const { seedDemo, DemoUserExistsError } = await import("../src/server/demo-seed.server.ts");

try {
  const result = await seedDemo({ reset });
  console.log(`[seed:demo] Demo data ${reset ? "recreated" : "created"}:
  login:        ${result.email} / ${result.password}
  categories:   ${result.categories}
  accounts:     ${result.accounts}
  transactions: ${result.transactions} (${result.dateRange[0]} → ${result.dateRange[1]})

Start the app with \`AI_FAKE=1 pnpm run dev\` and log in at http://127.0.0.1:3000`);
  process.exit(0);
} catch (error) {
  if (error instanceof DemoUserExistsError) {
    console.error(`[seed:demo] ${error.message}`);
    process.exit(1);
  }
  throw error;
}
