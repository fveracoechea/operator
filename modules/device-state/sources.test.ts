import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
// Bun has no temporary-directory, symlink, or recursive removal API.
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Err, Ok } from "unthrown";
import { Environment } from "../environment/main.ts";
import { OperatorHome } from "../operator-home/main.ts";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { migrationsFolder } from "./database.ts";
import { registerProject } from "./projects.ts";
import { registerSource, readSources, resetSource, pruneSource } from "./sources.ts";

let root = "";
afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
  root = "";
});

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

function endedDatabase() {
  const db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  migrate(drizzle(db), { migrationsFolder });
  expect(registerProject(db, project).tag).toBe("Ok");
  expect(
    registerSource(db, project.checkout, source, [
      { sourceId: "one", key: "done", completion: "report", state: "completed" },
      { sourceId: "one", key: "open", completion: "pr", state: "pr-open" },
    ]).tag,
  ).toBe("Ok");
  return db;
}
const target = { repository: project.repository, checkout: project.checkout, sourceId: "one" };

test("reset applies the caller's rule to facts from its own transaction", () => {
  using db = endedDatabase();
  db.exec(
    "INSERT INTO launches (id, source_id, assignment, attempt, state, name, resources, host, model, requested_model, reasoning_effort, release, skills, started_at) VALUES ('l1', 'one', 'open', 1, 'starting', 'n1', 'worktree', 'opencode', 'm', 'm', 'high', '{}', '[]', 'now')",
  );
  const unchanged = db.serialize();
  expect(
    resetSource(db, { ...target, checkout: "/other" }, () => Ok({ abandon: [] })),
  ).toMatchObject({
    tag: "Err",
    error: { reason: "controller_mismatch" },
  });
  expect(resetSource(db, { ...target, sourceId: "two" }, () => Ok({ abandon: [] }))).toMatchObject({
    tag: "Err",
    error: { reason: "source_not_found" },
  });
  let seen: unknown;
  expect(
    resetSource(db, target, (facts) => {
      seen = facts;
      return Err({ reason: "refused", detail: "no" });
    }),
  ).toMatchObject({ tag: "Err", error: { reason: "refused" } });
  // A start without a live owner is abandoned, so it holds no worker.
  expect(seen).toMatchObject({
    source: { id: "one", state: "open" },
    launches: [{ assignment: "open", state: "starting", abandoned: true }],
    cleanups: [],
    reports: [],
  });
  expect(db.serialize()).toEqual(unchanged);
  const reset = resetSource(db, target, () => Ok({ abandon: ["open"] }));
  expect(reset).toMatchObject({
    tag: "Ok",
    value: { source: { id: "one", state: "reset" }, retained: [] },
  });
  expect(db.query("SELECT key, state FROM assignments ORDER BY key").all()).toEqual([
    { key: "done", state: "completed" },
    { key: "open", state: "abandoned" },
  ]);
  const row = db
    .query<{ state: string; ended_at: string }, []>("SELECT state, ended_at FROM sources")
    .get();
  expect(row?.state).toBe("reset");
  expect(Number.isNaN(Date.parse(row?.ended_at ?? ""))).toBe(false);
});

test("prune deletes files and records together, and a refused path keeps both", async () => {
  root = await mkdtemp(path.join(tmpdir(), "operator-source-prune-"));
  const paths = OperatorHome.resolve(Environment.parse({ HOME: root, NODE_ENV: "test" }));
  using db = endedDatabase();
  db.exec(
    "UPDATE sources SET state = 'reset', ended_at = 'old'; UPDATE assignments SET state = 'abandoned' WHERE key = 'open'",
  );
  db.exec(
    `INSERT INTO launches (id, source_id, assignment, attempt, state, name, resources, branch, host, model, requested_model, reasoning_effort, release, skills, started_at, worktree_path) VALUES ('l1', 'one', 'open', 1, 'interrupted', 'n1', 'worktree', 'task/open', 'opencode', 'm', 'm', 'high', '{}', '[]', 'now', '${root}/kept'), ('l2', 'one', 'done', 1, 'finished', 'n2', 'worktree', 'task/done', 'opencode', 'm', 'm', 'high', '{}', '[]', 'now', '${root}/removed')`,
  );
  // An open PR and an existing worktree stay. A worktree that a cleanup removed is not listed.
  db.exec(
    "INSERT INTO pull_requests (source_id, assignment, repository, number, url, branch, associated_at, progress, wait_state) VALUES ('one', 'open', 'owner/one', 8, 'https://github.com/owner/one/pull/8', 'task/open', 'now', '{}', 'idle')",
  );
  await mkdir(`${root}/kept`);
  const directory = OperatorHome.sourceDirectory(paths, {
    repository: project.repository,
    sourceId: "one",
  });
  const sibling = OperatorHome.sourceDirectory(paths, {
    repository: project.repository,
    sourceId: "two",
  });
  await Bun.write(`${directory}/assignments/open/brief.md`, "brief", { createPath: true });
  await Bun.write(`${sibling}/keep`, "keep", { createPath: true });
  const unchanged = db.serialize();
  expect(pruneSource(db, paths, target, () => false)).toEqual(Ok(null));
  expect(db.serialize()).toEqual(unchanged);

  // A linked source folder is external content. It stays, and so do the records.
  await rm(directory, { recursive: true });
  await Bun.write(`${root}/outside/brief.md`, "outside", { createPath: true });
  await symlink(`${root}/outside`, directory);
  expect(pruneSource(db, paths, target, () => true)).toMatchObject({
    tag: "Err",
    error: { reason: "source_prune_failed" },
  });
  expect(db.serialize()).toEqual(unchanged);
  expect(await Bun.file(`${root}/outside/brief.md`).text()).toBe("outside");
  await rm(directory);
  await Bun.write(`${directory}/assignments/open/brief.md`, "brief", { createPath: true });

  expect(pruneSource(db, paths, target, () => true)).toMatchObject({
    tag: "Ok",
    value: {
      source: { id: "one" },
      retained: [
        {
          assignment: "open",
          worktreePath: `${root}/kept`,
          branch: "task/open",
          pullRequest: "https://github.com/owner/one/pull/8",
        },
      ],
    },
  });
  for (const table of [
    "sources",
    "assignments",
    "launches",
    "reports",
    "cleanups",
    "pull_requests",
  ])
    expect(db.query(`SELECT * FROM ${table}`).all()).toEqual([]);
  expect(await Bun.file(`${directory}/assignments/open/brief.md`).exists()).toBe(false);
  expect(await Bun.file(`${sibling}/keep`).text()).toBe("keep");
  expect(db.query("SELECT repository FROM projects").all()).toEqual([
    { repository: project.repository },
  ]);
});
