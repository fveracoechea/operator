import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { getTableConfig } from "drizzle-orm/sqlite-core";
import { migrationsFolder } from "./database.ts";
import { generateSQLiteDrizzleJson } from "drizzle-kit/api";
import { z } from "zod";
import * as schema from "./schema.ts";
import { projects, projectRemovals } from "./schema.ts";

test("delivery selection roundtrips as booleans rather than SQLite integers", () => {
  using client = new Database(":memory:");
  migrate(drizzle(client), { migrationsFolder });
  const db = drizzle(client);
  for (const selected of [true, false]) {
    db.insert(schema.deliveries)
      .values({
        id: String(selected),
        launchId: "l1",
        head: "h1",
        selected,
        startedAt: "now",
        requestUuid: "u1",
      })
      .run();
  }
  expect(
    db
      .select({ selected: schema.deliveries.selected, uuid: schema.deliveries.requestUuid })
      .from(schema.deliveries)
      .all(),
  ).toEqual([
    { selected: true, uuid: "u1" },
    { selected: false, uuid: "u1" },
  ]);
});

test("the shipped migration implements the Drizzle project schema", () => {
  using db = new Database(":memory:");
  migrate(drizzle(db), { migrationsFolder });
  expect(getTableConfig(projects).columns.map((column) => column.name)).toEqual([
    "repository",
    "checkout",
    "registered_at",
  ]);
  const row = { repository: "owner/repo", checkout: "/isolated/project", registeredAt: "now" };
  drizzle(db).insert(projects).values(row).run();
  expect(drizzle(db).select().from(projects).all()).toEqual([row]);
  expect(() => db.run("INSERT INTO projects (repository) VALUES ('other/repo')")).toThrow();
  expect(() =>
    drizzle(db)
      .insert(projects)
      .values({ ...row, checkout: "/different" })
      .run(),
  ).toThrow();
});

test("removal obligations survive deletion of the project and enforce one pending cleanup per identity", () => {
  using db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  migrate(drizzle(db), { migrationsFolder });
  drizzle(db)
    .insert(projectRemovals)
    .values({ repository: "owner/removed", removedAt: "now" })
    .run();
  expect(drizzle(db).select().from(projectRemovals).all()).toEqual([
    { repository: "owner/removed", removedAt: "now" },
  ]);
  expect(() => db.exec("INSERT INTO project_removals VALUES ('owner/removed', 'later')")).toThrow();
});

test("the Drizzle schema needs no migration beyond the shipped history", async () => {
  const journal = z
    .object({ entries: z.array(z.object({ tag: z.string() })) })
    .parse(await Bun.file(`${migrationsFolder}/meta/_journal.json`).json());
  const latest = journal.entries.at(-1)?.tag.slice(0, 4);
  const snapshot = z.object({ tables: z.record(z.string(), z.unknown()) });
  const shipped = snapshot.parse(
    await Bun.file(`${migrationsFolder}/meta/${latest}_snapshot.json`).json(),
  );
  const current = snapshot.parse(await generateSQLiteDrizzleJson(schema));
  expect(Object.keys(current.tables)).toHaveLength(21);
  expect(current.tables).toEqual(shipped.tables);
});
