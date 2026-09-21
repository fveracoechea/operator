import { afterEach, expect, test } from "bun:test";
import { getTableName, sql } from "drizzle-orm";
// Bun has no recursive directory removal API.
import { rm } from "node:fs/promises";
import { createState, type OpenResult } from "./database.ts";
import { crewStateSchema, declaredColumns } from "./schema.ts";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

type TableInfoRow = { name: string; notnull: number; pk: number };

async function openNewState(): Promise<Extract<OpenResult, { status: "open" }>> {
  const root = `${Bun.env.TMPDIR ?? "/tmp"}/operator-schema-${crypto.randomUUID()}`;
  roots.push(root);
  await Bun.$`mkdir -p ${root}`.quiet();

  const opened = await createState(root, new Date().toISOString());
  if (opened.status !== "open") {
    throw new Error(`the state could not be created: ${opened.status}`);
  }

  return opened;
}

/** Reports why the database refused a statement, following the cause the driver wrapped. */
function refuses(opened: Extract<OpenResult, { status: "open" }>, statement: string): string {
  try {
    opened.db.run(sql.raw(statement));
  } catch (error) {
    const reasons: string[] = [];
    for (let cause: unknown = error; cause !== undefined && cause !== null;) {
      reasons.push(String(cause));
      cause = cause instanceof Error ? cause.cause : null;
    }
    return reasons.join(" | ");
  }

  return "";
}

/**
 * The create statements and the Drizzle definitions are two renderings of one schema.
 * This proves they agree, so a column added to one and not the other fails the gate.
 */
test("the created tables match the declared Drizzle schema", async () => {
  const opened = await openNewState();

  for (const [name, table] of Object.entries(crewStateSchema)) {
    const tableName = getTableName(table);
    const rows = opened.db.all<TableInfoRow>(sql.raw(`pragma table_info(${tableName})`));
    const observed = rows
      .map((row) => ({ name: row.name, notNull: row.notnull === 1 || row.pk === 1 }))
      .toSorted((left, right) => left.name.localeCompare(right.name));

    expect(observed, `table ${name} (${tableName})`).toEqual(declaredColumns(table));
  }

  opened.close();
});

/**
 * The column comparison cannot see a constraint, and the constraints carry the rules that make
 * a claim atomic and an assignment unique. Each one is proven by the write it must refuse.
 */
test("the database refuses a second active attempt on one assignment", async () => {
  const opened = await openNewState();
  opened.db.run(
    sql.raw(`insert into work_sources values ('s1', 'ticket', 'r1', 'github', 0, 'now')`),
  );
  opened.db.run(
    sql.raw(
      `insert into assignments values ('a1', 's1', 'k1', 'r1', 'One', 'production', 0,
       'scope', '[]', '{}', '[]', 'fi', 'claimed', 1, 'now', 'now')`,
    ),
  );
  opened.db.run(
    sql.raw(`insert into attempts values ('t1', 'a1', 'owner', 'active', 1, 'now', null)`),
  );

  const refusal = refuses(
    opened,
    `insert into attempts values ('t2', 'a1', 'owner', 'active', 1, 'now', null)`,
  );

  expect(refusal).toContain("UNIQUE");
  opened.close();
});

test("the database refuses two assignments for one source key", async () => {
  const opened = await openNewState();
  opened.db.run(
    sql.raw(`insert into work_sources values ('s1', 'ticket', 'r1', 'github', 0, 'now')`),
  );
  const values = `'s1', 'k1', 'r1', 'One', 'production', 0, 'scope', '[]', '{}', '[]', 'fi',
    'registered', 1, 'now', 'now'`;
  opened.db.run(sql.raw(`insert into assignments values ('a1', ${values})`));

  const refusal = refuses(opened, `insert into assignments values ('a2', ${values})`);

  expect(refusal).toContain("UNIQUE");
  opened.close();
});

test("the database refuses a second open question on one attempt", async () => {
  const opened = await openNewState();
  opened.db.run(
    sql.raw(`insert into work_sources values ('s1', 'ticket', 'r1', 'github', 0, 'now')`),
  );
  opened.db.run(
    sql.raw(
      `insert into assignments values ('a1', 's1', 'k1', 'r1', 'One', 'production', 0,
       'scope', '[]', '{}', '[]', 'fi', 'claimed', 1, 'now', 'now')`,
    ),
  );
  opened.db.run(
    sql.raw(`insert into attempts values ('t1', 'a1', 'owner', 'active', 1, 'now', null)`),
  );
  const values = `'a1', 't1', 1, 'open', '{}', 'ti', '[]', null, null, null, null, 'now', 'now'`;
  opened.db.run(sql.raw(`insert into questions values ('q1', ${values})`));

  const refusal = refuses(opened, `insert into questions values ('q2', ${values})`);

  expect(refusal).toContain("UNIQUE");
  opened.close();
});

test("the database refuses an attempt on an assignment that does not exist", async () => {
  const opened = await openNewState();

  const refusal = refuses(
    opened,
    `insert into attempts values ('t1', 'missing', 'owner', 'active', 1, 'now', null)`,
  );

  expect(refusal).toContain("FOREIGN KEY");
  opened.close();
});

test("the database refuses text where the schema declares a whole number", async () => {
  const opened = await openNewState();

  const refusal = refuses(
    opened,
    `insert into work_sources values ('s1', 'ticket', 'r1', 'github', 'first', 'now')`,
  );

  expect(refusal).toContain("cannot store TEXT value in INTEGER column");
  opened.close();
});
