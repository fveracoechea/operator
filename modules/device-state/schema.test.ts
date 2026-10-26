import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { getTableConfig } from "drizzle-orm/sqlite-core";
import { migrationsFolder } from "./database.ts";
import { projects, projectRemovals } from "./schema.ts";

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
