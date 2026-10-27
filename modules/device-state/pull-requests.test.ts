import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { migrationsFolder } from "./database.ts";
import { readSources, registerSource } from "./sources.ts";
import { registerProject, removeProject } from "./projects.ts";
import { observePane, reserveLaunch, updateLaunch } from "./launches.ts";
import {
  associatePullRequest,
  recordPullRequestWait,
  renewPullRequestWait,
  worktreeOwners,
} from "./pull-requests.ts";

function fixture() {
  const db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  migrate(drizzle(db), { migrationsFolder });
  registerProject(db, { repository: "owner/one", checkout: "/one", registeredAt: "now" });
  registerSource(
    db,
    "/one",
    {
      id: "s1",
      repository: "owner/one",
      trackerKey: "APP-1",
      state: "open",
      registeredAt: "now",
      endedAt: null,
      plan: "{}",
    },
    [
      { sourceId: "s1", key: "change", completion: "pr", state: "ready" },
      { sourceId: "s1", key: "other", completion: "pr", state: "ready" },
      { sourceId: "s1", key: "read", completion: "report", state: "ready" },
    ],
  );
  return db;
}

function start(db: Database, id: string, assignment: string, paneId: string) {
  const reserved = reserveLaunch(db, "/one", "owner/one", {
    id,
    sourceId: "s1",
    assignment,
    state: "starting",
    name: `launch-${id}`,
    resources: "worktree",
    branch: `task/${assignment}`,
    host: "opencode",
    model: "test/model",
    requestedModel: "test/model",
    reasoningEffort: "medium",
    profile: null,
    release: "{}",
    skills: "[]",
    herdrSocket: "/herdr.sock",
    workspaceId: null,
    tabId: null,
    paneId: null,
    worktreePath: null,
    worktreeWorkspaceId: null,
    startedAt: "now",
    endedAt: null,
    failureReason: null,
    failureDetail: null,
    activity: null,
    activityAt: null,
  });
  expect(reserved.tag).toBe("Ok");
  expect(
    updateLaunch(db, id, { paneId, worktreePath: `/worktrees/${assignment}`, state: "running" })
      .tag,
  ).toBe("Ok");
}

function interrupt(db: Database, paneId: string) {
  observePane(db, {
    socket: "/herdr.sock",
    paneId,
    workspaceId: null,
    observation: { exited: true },
  });
}

const pr = { number: 7, url: "https://github.com/owner/one/pull/7", branch: "task/change" };

function assignmentState(db: Database, key: string) {
  return db.query("SELECT state FROM assignments WHERE key = ?").get(key);
}

test("worktree owners list the latest start of each assignment with its owning records", () => {
  using db = fixture();
  start(db, "l1", "change", "p1");
  interrupt(db, "p1");
  start(db, "l2", "change", "p2");
  expect(worktreeOwners(db)).toMatchObject({
    tag: "Ok",
    value: [
      {
        launchId: "l2",
        attempt: 2,
        launchState: "running",
        worktreePath: "/worktrees/change",
        branch: "task/change",
        sourceState: "open",
        repository: "owner/one",
        checkout: "/one",
        assignment: "change",
        completion: "pr",
        assignmentState: "running",
      },
    ],
  });
});

test("association moves a running PR assignment to PR open once and repeats without change", () => {
  using db = fixture();
  start(db, "l1", "change", "p1");
  const first = associatePullRequest(db, "l1", pr);
  expect(first).toMatchObject({
    tag: "Ok",
    value: { changed: true, row: { number: 7, waitState: "idle", repository: "owner/one" } },
  });
  expect(assignmentState(db, "change")).toEqual({ state: "pr-open" });
  expect(associatePullRequest(db, "l1", pr)).toMatchObject({
    tag: "Ok",
    value: { changed: false },
  });
  expect(associatePullRequest(db, "l1", { ...pr, number: 8 })).toMatchObject({
    error: { reason: "pr_already_associated" },
  });
  expect(db.query("SELECT number FROM pull_requests").all()).toEqual([{ number: 7 }]);
});

test("one PR belongs to one open assignment, and a stale or report owner changes nothing", () => {
  using db = fixture();
  start(db, "l1", "change", "p1");
  start(db, "l2", "other", "p2");
  start(db, "l3", "read", "p3");
  expect(associatePullRequest(db, "l1", pr).tag).toBe("Ok");
  expect(associatePullRequest(db, "l2", pr)).toMatchObject({
    error: { reason: "pr_owned_elsewhere" },
  });
  expect(associatePullRequest(db, "l3", { ...pr, number: 9 })).toMatchObject({
    error: { reason: "pr_owner_inactive" },
  });
  interrupt(db, "p2");
  expect(associatePullRequest(db, "l2", { ...pr, number: 9 })).toMatchObject({
    error: { reason: "pr_owner_inactive" },
  });
  expect(associatePullRequest(db, "missing", { ...pr, number: 9 })).toMatchObject({
    error: { reason: "pr_owner_inactive" },
  });
  expect(assignmentState(db, "other")).toEqual({ state: "running" });
  expect(assignmentState(db, "read")).toEqual({ state: "running" });
  expect(db.query("SELECT assignment FROM pull_requests").all()).toEqual([
    { assignment: "change" },
  ]);
});

test("a replacement keeps PR open and only the latest running owner records waits", () => {
  using db = fixture();
  start(db, "l1", "change", "p1");
  associatePullRequest(db, "l1", pr);
  interrupt(db, "p1");
  expect(
    recordPullRequestWait(db, "l1", (row) => ({ progress: row.progress, waitState: "waiting" })),
  ).toMatchObject({ error: { reason: "pr_owner_inactive" } });
  start(db, "l2", "change", "p2");
  expect(assignmentState(db, "change")).toEqual({ state: "pr-open" });
  expect(
    recordPullRequestWait(db, "l2", (row) => ({
      progress: '{"seen":["a"]}',
      waitState: row.waitState,
    })),
  ).toMatchObject({ tag: "Ok", value: { progress: '{"seen":["a"]}', waitState: "idle" } });
  expect(recordPullRequestWait(db, "l2", () => null)).toMatchObject({ tag: "Ok", value: null });
  expect(db.query("SELECT progress, wait_state FROM pull_requests").get()).toEqual({
    progress: '{"seen":["a"]}',
    wait_state: "idle",
  });
});

test("a wait without an associated PR refuses, and project removal deletes PR records", () => {
  using db = fixture();
  start(db, "l1", "change", "p1");
  expect(recordPullRequestWait(db, "l1", () => null)).toMatchObject({
    error: { reason: "pr_not_associated" },
  });
  associatePullRequest(db, "l1", pr);
  db.exec(
    "UPDATE launches SET state = 'interrupted'; UPDATE sources SET state = 'reset', ended_at = 'later'",
  );
  expect(removeProject(db, "owner/one").tag).toBe("Ok");
  expect(db.query("SELECT * FROM pull_requests").all()).toEqual([]);
});

test("a running wait holds a lease that its result releases, and a gone owner reads as stopped", () => {
  using db = fixture();
  start(db, "l1", "change", "p1");
  associatePullRequest(db, "l1", pr);
  function lease() {
    return db.query("SELECT wait_owner_pid AS pid, wait_lease_at AS at FROM pull_requests").get();
  }
  function stopped() {
    const read = readSources(db, "owner/one");
    return read.tag === "Ok" ? read.value[0]?.pullRequests[0]?.waitStopped : undefined;
  }
  recordPullRequestWait(db, "l1", (row) => ({ progress: row.progress, waitState: "waiting" }));
  expect(lease()).toMatchObject({ pid: process.pid });
  expect(stopped()).toBe(false);
  db.exec("UPDATE pull_requests SET wait_lease_at = '2000-01-01T00:00:00.000Z'");
  expect(stopped()).toBe(true);
  expect(renewPullRequestWait(db, "s1", "change").tag).toBe("Ok");
  expect(stopped()).toBe(false);
  const gone = Bun.spawnSync([process.execPath, "--version"]).pid;
  db.query("UPDATE pull_requests SET wait_owner_pid = ?").run(gone);
  expect(stopped()).toBe(true);
  recordPullRequestWait(db, "l1", (row) => ({ progress: row.progress, waitState: "timed_out" }));
  expect(lease()).toEqual({ pid: null, at: null });
  expect(stopped()).toBe(false);
});

test("a wait from a launch on another branch than the PR changes nothing", () => {
  using db = fixture();
  start(db, "l1", "change", "p1");
  associatePullRequest(db, "l1", pr);
  db.exec("UPDATE launches SET branch = 'task/change-2'");
  expect(
    recordPullRequestWait(db, "l1", (row) => ({ progress: row.progress, waitState: "waiting" })),
  ).toMatchObject({ error: { reason: "pr_branch_mismatch" } });
  expect(db.query("SELECT wait_state FROM pull_requests").get()).toEqual({ wait_state: "idle" });
});
