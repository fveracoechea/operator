import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { migrationsFolder } from "./database.ts";
import { registerProject } from "./projects.ts";
import { registerSource, readSources } from "./sources.ts";

const project = { repository: "owner/one", checkout: "/isolated/one", registeredAt: "now" };
const source = {
  id: "one",
  repository: project.repository,
  trackerKey: "APP-1",
  state: "open",
  registeredAt: "now",
  endedAt: null,
  plan: "{}",
};
test("stores sources and assignments atomically and scopes reads by project", () => {
  using db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  migrate(drizzle(db), { migrationsFolder });
  expect(registerProject(db, project).tag).toBe("Ok");
  expect(registerSource(db, "/other", source, [])).toMatchObject({
    tag: "Err",
    error: { reason: "controller_mismatch" },
  });
  expect(db.query("SELECT * FROM sources").all()).toEqual([]);
  expect(
    registerSource(db, project.checkout, source, [
      { sourceId: "missing", key: "read", completion: "report", state: "ready" },
    ]).tag,
  ).toBe("Defect");
  expect(db.query("SELECT * FROM sources").all()).toEqual([]);
  expect(
    registerSource(db, project.checkout, source, [
      { sourceId: "one", key: "read", completion: "report", state: "ready" },
    ]).tag,
  ).toBe("Ok");
  expect(registerSource(db, project.checkout, { ...source, id: "two" }, [])).toMatchObject({
    tag: "Err",
    error: { reason: "source_parent_open" },
  });
  expect(readSources(db, project.repository, "one")).toMatchObject({
    tag: "Ok",
    value: [{ source, assignments: [{ key: "read" }] }],
  });
  expect(readSources(db, "other/repo")).toMatchObject({ tag: "Ok", value: [] });
  expect(readSources(db, "other/repo", "one")).toMatchObject({
    tag: "Err",
    error: { reason: "source_not_found" },
  });
  db.exec("UPDATE sources SET state = 'reset', ended_at = 'later'");
  expect(registerSource(db, project.checkout, { ...source, id: "two" }, []).tag).toBe("Ok");
  expect(db.query("SELECT id FROM sources ORDER BY id").all()).toEqual([
    { id: "one" },
    { id: "two" },
  ]);
});
