import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { describe, expect, it } from "vitest";
import { assertSchemaUpToDate, runMigrations } from "#/db/migrate";

const migrationsFolder = join(process.cwd(), "drizzle");

function freshDb() {
  const client = new PGlite();
  return drizzle(client);
}

/** A copy of the migrations folder that stops just before `tag`. */
function migrationsFolderBefore(tag: string): string {
  const journal = JSON.parse(
    readFileSync(join(migrationsFolder, "meta", "_journal.json"), "utf8"),
  ) as { entries: Array<{ tag: string }> };
  const cut = journal.entries.findIndex((e) => e.tag === tag);
  if (cut === -1) throw new Error(`Unknown migration ${tag}`);

  const folder = mkdtempSync(join(tmpdir(), "migrations-"));
  mkdirSync(join(folder, "meta"));
  const entries = journal.entries.slice(0, cut);
  for (const entry of entries) {
    copyFileSync(
      join(migrationsFolder, `${entry.tag}.sql`),
      join(folder, `${entry.tag}.sql`),
    );
  }
  writeFileSync(
    join(folder, "meta", "_journal.json"),
    JSON.stringify({ ...journal, entries }),
  );
  return folder;
}

describe("startup migrations", () => {
  it("applies all migrations to an empty database and is idempotent", async () => {
    const db = freshDb();
    await runMigrations(db, "pglite", migrationsFolder);

    const result = await db.execute(
      sql`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'`,
    );
    const names = new Set(
      (result.rows as Array<{ table_name: string }>).map((t) => t.table_name),
    );
    for (const table of ["users", "accounts", "transactions", "receipts"]) {
      expect(names.has(table), table).toBe(true);
    }

    // Second run applies nothing and does not throw.
    const applied = async () => {
      const res = await db.execute(
        sql`SELECT count(*)::int AS c FROM drizzle.__drizzle_migrations`,
      );
      return (res.rows[0] as { c: number }).c;
    };
    const before = await applied();
    await runMigrations(db, "pglite", migrationsFolder);
    expect(await applied()).toBe(before);
  });

  it("0004 turns positive receipt transactions into expenses and leaves others alone", async () => {
    // Bring a database to the schema just before 0004, as an existing
    // deployment would be, then apply the rest.
    const db = freshDb();
    await runMigrations(
      db,
      "pglite",
      migrationsFolderBefore("0004_receipt_transactions_as_expenses"),
    );
    await db.execute(
      sql`INSERT INTO users (id, username, password_hash) VALUES ('u1', 'u1', 'x')`,
    );
    await db.execute(
      sql`INSERT INTO accounts (id, user_id, name) VALUES ('a1', 'u1', 'Main')`,
    );
    await db.execute(sql`
      INSERT INTO transactions (id, user_id, account_id, date, amount_minor, source) VALUES
        ('receipt-buggy', 'u1', 'a1', '2026-11-01', 3699, 'receipt'),
        ('receipt-ok', 'u1', 'a1', '2026-11-02', -1200, 'receipt'),
        ('salary', 'u1', 'a1', '2026-11-01', 850000, 'manual'),
        ('import-refund', 'u1', 'a1', '2026-11-03', 1500, 'import'),
        ('expense', 'u1', 'a1', '2026-11-04', -500, 'manual');
    `);

    await runMigrations(db, "pglite", migrationsFolder);

    const result = await db.execute(
      sql`SELECT id, amount_minor FROM transactions ORDER BY id`,
    );
    const amounts = Object.fromEntries(
      (result.rows as Array<{ id: string; amount_minor: number }>).map(
        (r) => [r.id, r.amount_minor],
      ),
    );
    expect(amounts).toEqual({
      "receipt-buggy": -3699,
      "receipt-ok": -1200,
      salary: 850000,
      "import-refund": 1500,
      expense: -500,
    });
  });

  it("assertSchemaUpToDate throws when migrations are missing", async () => {
    const db = freshDb();
    await runMigrations(db, "pglite", migrationsFolder);

    await db.execute(
      sql`DELETE FROM drizzle.__drizzle_migrations WHERE id = (SELECT max(id) FROM drizzle.__drizzle_migrations)`,
    );

    await expect(assertSchemaUpToDate(db, migrationsFolder)).rejects.toThrow(
      /Schema out of date/,
    );
  });
});
