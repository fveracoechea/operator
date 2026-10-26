import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { migrationsFolder } from "./database.ts";
import { registerProject, lookupProject } from "./projects.ts";

test("uses Drizzle constraints and atomic identity and controller guards", () => {
  using db = new Database(":memory:");
  migrate(drizzle(db), { migrationsFolder });
  const one = {
    repository: "owner/one",
    checkout: "/isolated/one",
    registeredAt: "2026-10-25T00:00:00Z",
  };
  expect(registerProject(db, one)).toMatchObject({
    tag: "Ok",
    value: { reason: "project_registered", data: one },
  });
  expect(registerProject(db, { ...one, registeredAt: "later" })).toMatchObject({
    tag: "Ok",
    value: { reason: "project_unchanged", data: one },
  });
  expect(registerProject(db, { ...one, checkout: "/isolated/alternate" })).toMatchObject({
    tag: "Err",
    error: { reason: "controller_mismatch" },
  });
  expect(registerProject(db, { ...one, repository: "owner/renamed" })).toMatchObject({
    tag: "Err",
    error: { reason: "controller_identity_mismatch" },
  });
  expect(lookupProject(db, one.checkout, [one.repository])).toMatchObject({
    tag: "Ok",
    value: { controller: one, matches: [one] },
  });
  expect(lookupProject(db, "/unregistered", [])).toMatchObject({
    tag: "Ok",
    value: { matches: [] },
  });
  expect(db.query("SELECT repository FROM projects").all()).toEqual([{ repository: "owner/one" }]);
  expect(() =>
    drizzle(db).run("INSERT INTO projects VALUES ('other/repo', '/isolated/one', 'now')"),
  ).toThrow();
});
