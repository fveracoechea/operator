import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
// Bun has no temporary-directory, symlink, mode, or recursive removal API.
import { chmod, mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
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
import { busy, insertRow, reservedCopy } from "./state-fixture.ts";

// Root ignores file modes, so a test of a denied access cannot run as root.
const asRoot = process.getuid?.() === 0;

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
  // A review request has its own lifecycle (ADR-0015), so prune keeps it with its source id.
  insertRow(db, "review_requests", {
    id: "r1",
    repository: project.repository,
    number: 8,
    origin: "assignment",
    source_id: "one",
    assignment: "open",
    state: "approved",
  });
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
  expect(db.query("SELECT id, source_id FROM review_requests").all()).toEqual([
    { id: "r1", source_id: "one" },
  ]);
  expect(db.query("SELECT repository FROM projects").all()).toEqual([
    { repository: project.repository },
  ]);
});

function stopped() {
  return Bun.spawnSync([process.execPath, "--version"]).pid;
}

test("refusals name the recorded fact, and reads scope by source", () => {
  using db = endedDatabase();
  for (const repository of ["owner/unregistered", project.repository])
    expect(registerSource(db, "/other", { ...source, id: "x", repository }, [])).toMatchObject({
      tag: "Err",
      error: {
        reason: "controller_mismatch",
        detail: "The controlling checkout changed before registration. Read the project again.",
      },
    });
  expect(registerSource(db, project.checkout, { ...source, id: "two" }, [])).toMatchObject({
    tag: "Err",
    error: { reason: "source_parent_open", detail: "Source one is still open for APP-1." },
  });
  registerSource(db, project.checkout, { ...source, id: "two", trackerKey: "APP-2" }, []);
  expect(
    readSources(db, project.repository)
      .getOrNull()
      ?.map((row) => row.source.id),
  ).toEqual(["one", "two"]);
  expect(
    readSources(db, project.repository, "two")
      .getOrNull()
      ?.map((row) => row.source.id),
  ).toEqual(["two"]);
  expect(readSources(db, project.repository, "three")).toMatchObject({
    tag: "Err",
    error: { reason: "source_not_found", detail: "The source does not exist in this project." },
  });
  for (const changed of [
    { ...target, checkout: "/other" },
    { ...target, repository: "other/repo" },
  ])
    expect(resetSource(db, changed, () => Ok({ abandon: [] }))).toMatchObject({
      tag: "Err",
      error: {
        reason: "controller_mismatch",
        detail: "The controlling checkout changed. Read the project again. Nothing changed.",
      },
    });
  expect(
    resetSource(db, { ...target, sourceId: "three" }, () => Ok({ abandon: [] })),
  ).toMatchObject({
    tag: "Err",
    error: {
      reason: "source_not_found",
      detail: "The source does not exist in this project. Nothing changed.",
    },
  });
});

test("a read marks abandoned starts, stopped PR waits, and running cleanups", () => {
  using db = endedDatabase();
  const lease = new Date().toISOString();
  const gone = stopped();
  for (const [id, assignment, state, pid] of [
    ["l1", "open", "starting", gone],
    ["l2", "open", "starting", process.pid],
    ["l3", "done", "running", gone],
  ] as const)
    insertRow(db, "launches", {
      id,
      source_id: "one",
      assignment,
      attempt: Number(id.slice(1)),
      state,
      owner_pid: pid,
      lease_at: lease,
    });
  insertRow(db, "pull_requests", {
    source_id: "one",
    assignment: "open",
    wait_state: "waiting",
    wait_owner_pid: gone,
    wait_lease_at: lease,
  });
  insertRow(db, "pull_requests", {
    source_id: "one",
    assignment: "done",
    wait_state: "idle",
    wait_owner_pid: gone,
    wait_lease_at: lease,
  });
  insertRow(db, "cleanups", {
    source_id: "one",
    assignment: "open",
    launch_id: "l1",
    state: "pending",
    owner_pid: process.pid,
    lease_at: lease,
  });
  insertRow(db, "cleanups", {
    source_id: "one",
    assignment: "done",
    launch_id: "l3",
    state: "pending",
    owner_pid: null,
    lease_at: null,
  });
  const [read] = readSources(db, project.repository).getOrNull() ?? [];
  expect(read?.launches.map((launch) => [launch.id, launch.abandoned])).toEqual([
    ["l3", false],
    ["l1", true],
    ["l2", false],
  ]);
  expect(
    Object.fromEntries(read?.pullRequests.map((pr) => [pr.assignment, pr.waitStopped]) ?? []),
  ).toEqual({ open: true, done: false });
  expect(
    Object.fromEntries(
      read?.cleanups.map((cleanup) => [cleanup.assignment, cleanup.running]) ?? [],
    ),
  ).toEqual({ open: true, done: false });
  db.query("UPDATE pull_requests SET wait_owner_pid = ? WHERE assignment = 'open'").run(
    process.pid,
  );
  db.query("UPDATE cleanups SET owner_pid = ? WHERE assignment = 'open'").run(gone);
  const [later] = readSources(db, project.repository).getOrNull() ?? [];
  expect(later?.pullRequests.map((pr) => pr.waitStopped)).toEqual([false, false]);
  expect(later?.cleanups.map((cleanup) => cleanup.running)).toEqual([false, false]);
  let facts: unknown;
  resetSource(db, target, (seen) => {
    facts = seen.launches.map((launch) => [launch.assignment, launch.state, launch.abandoned]);
    return Err({ reason: "refused", detail: "no" });
  });
  expect(facts).toEqual(
    expect.arrayContaining([
      ["open", "starting", true],
      ["open", "starting", false],
      ["done", "running", false],
    ]),
  );
});

test("a reset lists the retained worktrees and unmerged PRs of the abandoned assignments only", async () => {
  root = await mkdtemp(path.join(tmpdir(), "operator-source-reset-"));
  using db = endedDatabase();
  registerSource(db, project.checkout, { ...source, id: "x", trackerKey: "X" }, []);
  db.exec(
    "INSERT INTO assignments VALUES ('one', 'other', 'pr', 'pr-open'), ('one', 'merged', 'pr', 'merged')",
  );
  await mkdir(`${root}/open`);
  await mkdir(`${root}/other`);
  for (const [id, assignment, attempt, worktree] of [
    ["l1", "open", 1, `${root}/open`],
    // A second attempt on the same worktree is one retained worktree.
    ["l2", "open", 2, `${root}/open`],
    ["l3", "other", 1, `${root}/other`],
    ["l4", "done", 1, `${root}/removed`],
  ] as const)
    insertRow(db, "launches", {
      id,
      source_id: "one",
      assignment,
      attempt,
      state: "finished",
      branch: `task/${assignment}`,
      worktree_path: worktree,
    });
  for (const [assignment, merged] of [
    ["open", null],
    ["other", null],
    ["merged", "head"],
    ["done", null],
  ] as const)
    insertRow(db, "pull_requests", {
      source_id: "one",
      assignment,
      url: `https://github.com/owner/one/pull/${assignment}`,
      branch: `task/${assignment}`,
      merged_head: merged,
    });
  expect(resetSource(db, target, () => Ok({ abandon: ["open", "done", "merged"] }))).toMatchObject({
    tag: "Ok",
    value: {
      retained: [
        {
          assignment: "open",
          worktreePath: `${root}/open`,
          branch: "task/open",
          pullRequest: "https://github.com/owner/one/pull/open",
        },
        {
          assignment: "done",
          worktreePath: null,
          branch: "task/done",
          pullRequest: "https://github.com/owner/one/pull/done",
        },
      ],
    },
  });
  expect(
    db.query("SELECT key, state FROM assignments WHERE source_id = 'one' ORDER BY key").all(),
  ).toEqual([
    { key: "done", state: "abandoned" },
    { key: "merged", state: "abandoned" },
    { key: "open", state: "abandoned" },
    { key: "other", state: "pr-open" },
  ]);
});

test("a worktree with no PR keeps no PR link, and an empty abandon list changes no assignment", async () => {
  root = await mkdtemp(path.join(tmpdir(), "operator-source-reset-"));
  using db = endedDatabase();
  await mkdir(`${root}/open`);
  insertRow(db, "launches", {
    id: "l1",
    source_id: "one",
    assignment: "open",
    attempt: 1,
    state: "finished",
    branch: "task/open",
    worktree_path: `${root}/open`,
  });
  insertRow(db, "pull_requests", {
    source_id: "one",
    assignment: "done",
    url: "https://github.com/owner/one/pull/done",
    merged_head: "head",
  });
  expect(resetSource(db, target, () => Ok({ abandon: [] }))).toMatchObject({
    tag: "Ok",
    value: { retained: [] },
  });
  expect(db.query("SELECT key, state FROM assignments ORDER BY key").all()).toEqual([
    { key: "done", state: "completed" },
    { key: "open", state: "pr-open" },
  ]);
  db.exec("UPDATE sources SET state = 'open', ended_at = NULL");
  expect(resetSource(db, target, () => Ok({ abandon: ["open"] }))).toMatchObject({
    value: {
      retained: [
        {
          assignment: "open",
          worktreePath: `${root}/open`,
          branch: "task/open",
          pullRequest: null,
        },
      ],
    },
  });
});

test.skipIf(asRoot)(
  "prune deletes report and cleanup records, and a failed file removal keeps every record",
  async () => {
    root = await mkdtemp(path.join(tmpdir(), "operator-source-prune-"));
    const paths = OperatorHome.resolve(Environment.parse({ HOME: root, NODE_ENV: "test" }));
    using db = endedDatabase();
    db.exec("UPDATE sources SET state = 'reset', ended_at = 'old'");
    insertRow(db, "launches", { id: "l1", source_id: "one", assignment: "open", attempt: 1 });
    insertRow(db, "reports", { source_id: "one", assignment: "open", launch_id: "l1", number: 1 });
    insertRow(db, "cleanups", {
      source_id: "one",
      assignment: "open",
      launch_id: "l1",
      state: "done",
    });
    const directory = OperatorHome.sourceDirectory(paths, {
      repository: project.repository,
      sourceId: "one",
    });
    await Bun.write(`${directory}/assignments/open/brief.md`, "brief", { createPath: true });
    const unchanged = db.serialize();
    await chmod(`${directory}/assignments`, 0o500);
    try {
      expect(pruneSource(db, paths, target, () => true)).toMatchObject({
        tag: "Err",
        error: { reason: "source_prune_failed" },
      });
    } finally {
      await chmod(`${directory}/assignments`, 0o700);
    }
    expect(db.serialize()).toEqual(unchanged);
    expect(pruneSource(db, paths, target, () => true).tag).toBe("Ok");
    for (const table of ["sources", "assignments", "launches", "reports", "cleanups"])
      expect(db.query(`SELECT * FROM ${table}`).all(), table).toEqual([]);
  },
);

test("reads need no writer reservation, and source changes wait for it even when they refuse", async () => {
  root = await mkdtemp(path.join(tmpdir(), "operator-source-prune-"));
  const paths = OperatorHome.resolve(Environment.parse({ HOME: root, NODE_ENV: "test" }));
  using db = endedDatabase();
  using reserved = reservedCopy(db);
  expect(readSources(reserved.subject, project.repository).tag).toBe("Ok");
  expect(registerSource(reserved.subject, "/other", source, [])).toMatchObject(busy);
  expect(
    resetSource(reserved.subject, target, () => Err({ reason: "refused", detail: "no" })),
  ).toMatchObject(busy);
  expect(pruneSource(reserved.subject, paths, target, () => false)).toMatchObject(busy);
});
