// Runtime-only dialect assessment. It does not claim Drizzle declaration compatibility.
import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { integer, sqliteTable } from "drizzle-orm/sqlite-core";
import { Err, Ok } from "unthrown";
import metadata from "@unthrown/drizzle/package.json";

const rows = sqliteTable("probe", { id: integer().primaryKey() });

test("published unthrown Drizzle integration has a Postgres entry but no SQLite entry", async () => {
  expect(metadata.version).toBe("0.3.0");
  expect(Object.keys(metadata.exports)).toEqual([".", "./node-postgres", "./package.json"]);
  expect(metadata.peerDependencies["drizzle-orm"]).toBe("^1.0.0-rc.5-0");
  const postgres = await import("@unthrown/drizzle/node-postgres");
  expect(postgres.drizzle).toBeFunction();
  await expect(import("@unthrown/drizzle/bun-sqlite")).rejects.toThrow();
});

test("stock Drizzle SQLite commits returned unthrown Err and Defect values", () => {
  using sqlite = new Database(":memory:");
  sqlite.run("CREATE TABLE probe (id INTEGER PRIMARY KEY)");
  const db = drizzle({ client: sqlite });
  for (const [id, failure] of [
    [1, Err({ type: "refused" })],
    [
      2,
      Ok(0).map(() => {
        throw new TypeError("defect");
      }),
    ],
  ]) {
    const result = db.transaction(
      (tx) => {
        tx.insert(rows).values({ id }).run();
        return failure;
      },
      { behavior: "immediate" },
    );
    expect(result).toBe(failure);
  }
  expect(db.select().from(rows).all()).toEqual([{ id: 1 }, { id: 2 }]);
});

test("a SQLite owner can roll back both unthrown failure channels without persisting instances", () => {
  using sqlite = new Database(":memory:");
  sqlite.run("CREATE TABLE probe (id INTEGER PRIMARY KEY)");
  const db = drizzle({ client: sqlite });
  const rollback = Symbol("owner-private rollback");
  const cause = new TypeError("defect");
  for (const failure of [
    Err({ type: "refused" }),
    Ok(0).map(() => {
      throw cause;
    }),
  ]) {
    let observed;
    try {
      db.transaction(
        (tx) => {
          tx.insert(rows).values({ id: 1 }).run();
          observed = failure;
          if (!failure.isOk()) throw rollback;
        },
        { behavior: "immediate" },
      );
    } catch (error) {
      if (error !== rollback) throw error;
    }
    expect(observed).toBe(failure);
    expect(db.select().from(rows).all()).toEqual([]);
  }
});
