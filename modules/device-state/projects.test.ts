import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { migrationsFolder } from "./database.ts";
import {
  registerProject,
  lookupProject,
  listProjects,
  moveProject,
  removeProject,
} from "./projects.ts";

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

test("project management preserves scope and leaves a cleanup obligation after atomic record removal", () => {
  using db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  migrate(drizzle(db), { migrationsFolder });
  for (const name of ["one", "two"])
    expect(
      registerProject(db, {
        repository: `owner/${name}`,
        checkout: `/${name}`,
        registeredAt: "now",
      }).tag,
    ).toBe("Ok");
  db.exec(
    "INSERT INTO sources VALUES ('source', 'owner/one', 'APP-1', 'open', 'now', NULL, '{}'); INSERT INTO assignments VALUES ('source', 'task', 'report', 'ready')",
  );
  expect(listProjects(db)).toMatchObject({
    tag: "Ok",
    value: {
      projects: [
        { repository: "owner/one", openSources: 1 },
        { repository: "owner/two", openSources: 0 },
      ],
      pendingRemovals: [],
    },
  });
  expect(moveProject(db, "owner/one", "/alternate")).toMatchObject({
    tag: "Err",
    error: { reason: "project_source_open" },
  });
  expect(removeProject(db, "owner/one")).toMatchObject({
    tag: "Err",
    error: { reason: "project_source_open" },
  });
  expect(moveProject(db, "owner/two", "/one")).toMatchObject({
    tag: "Err",
    error: { reason: "controller_identity_mismatch" },
  });
  db.exec(
    "UPDATE sources SET state = 'reset', ended_at = 'later'; UPDATE assignments SET state = 'abandoned'",
  );
  expect(moveProject(db, "owner/one", "/alternate")).toMatchObject({
    tag: "Ok",
    value: { data: { checkout: "/alternate", registeredAt: "now" } },
  });
  expect(removeProject(db, "owner/one").tag).toBe("Ok");
  expect(removeProject(db, "owner/one").tag).toBe("Ok");
  expect(
    registerProject(db, { repository: "owner/one", checkout: "/alternate", registeredAt: "later" }),
  ).toMatchObject({ tag: "Err", error: { reason: "project_cleanup_pending" } });
  expect(db.query("SELECT * FROM sources").all()).toEqual([]);
  expect(db.query("SELECT * FROM assignments").all()).toEqual([]);
  expect(listProjects(db)).toMatchObject({
    tag: "Ok",
    value: {
      projects: [{ repository: "owner/two" }],
      pendingRemovals: [{ repository: "owner/one" }],
    },
  });
  expect(removeProject(db, "owner/absent")).toMatchObject({
    tag: "Err",
    error: { reason: "project_not_registered" },
  });
  expect(moveProject(db, "owner/absent", "/alternate")).toMatchObject({
    tag: "Err",
    error: { reason: "project_not_registered" },
  });
});
