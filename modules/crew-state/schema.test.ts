import { expect, test, afterEach } from "bun:test";
import { sql } from "drizzle-orm";
// Bun has no recursive directory removal API.
import { rm } from "node:fs/promises";
import { createState } from "./database.ts";
import { crewStateSchema, declaredColumns } from "./schema.ts";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

type TableInfoRow = { name: string; notnull: number; pk: number };

/**
 * The create statements and the Drizzle definitions are two renderings of one schema.
 * This proves they agree, so a column added to one and not the other fails the gate.
 */
test("the created tables match the declared Drizzle schema", async () => {
  const root = `${Bun.env.TMPDIR ?? "/tmp"}/operator-schema-${crypto.randomUUID()}`;
  roots.push(root);
  await Bun.$`mkdir -p ${root}`.quiet();

  const opened = await createState(root, new Date().toISOString());
  expect(opened.status).toBe("open");
  if (opened.status !== "open") {
    return;
  }

  for (const [name, table] of Object.entries(crewStateSchema)) {
    const tableName = String(table[Symbol.for("drizzle:Name") as unknown as keyof typeof table]);
    const rows = opened.db.all<TableInfoRow>(sql.raw(`pragma table_info(${tableName})`));
    const observed = rows
      .map((row) => ({ name: row.name, notNull: row.notnull === 1 || row.pk === 1 }))
      .toSorted((left, right) => left.name.localeCompare(right.name));

    expect(observed, `table ${name} (${tableName})`).toEqual(declaredColumns(table));
  }

  opened.close();
});
