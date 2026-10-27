import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { migrationsFolder } from "./database.ts";
import { registerSource } from "./sources.ts";
import { registerProject, removeProject } from "./projects.ts";
import { reserveLaunch, updateLaunch } from "./launches.ts";
import { associatePullRequest, recordPullRequestMerge } from "./pull-requests.ts";
import { advanceCleanup, claimCleanup, renewCleanup, startCleanup } from "./cleanups.ts";

function fixture(keys = ["change", "other"]) {
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
    keys.map((key) => ({ sourceId: "s1", key, completion: "pr", state: "ready" })),
  );
  const reserved = reserveLaunch(db, "/one", "owner/one", {
    id: "l1",
    sourceId: "s1",
    assignment: "change",
    state: "starting",
    name: "launch-l1",
    resources: "worktree",
    branch: "task/change",
    host: "opencode",
    model: "m",
    requestedModel: "m",
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
  updateLaunch(db, "l1", { paneId: "p1", worktreePath: "/w", state: "running" });
  return db;
}

const merge = { number: 7, head: "h1", mergeCommit: "m1" };
// The source decision belongs to work sources. These tests supply its rule.
function sourceState(rows: { completion: string; state: string }[]) {
  return rows.every((row) => row.state === "merged") ? "finished" : "open";
}

function associate(db: Database) {
  expect(
    associatePullRequest(db, "l1", { number: 7, url: "u", branch: "task/change", relay: null }).tag,
  ).toBe("Ok");
}

test("a verified merge records the merge, the merged state, and the first cleanup step at once", () => {
  using db = fixture();
  associate(db);
  expect(recordPullRequestMerge(db, "l1", merge, sourceState)).toMatchObject({
    tag: "Ok",
    value: { changed: true },
  });
  expect(db.query("SELECT state FROM assignments WHERE key = 'change'").get()).toEqual({
    state: "merged",
  });
  expect(db.query("SELECT merged_head, merge_commit FROM pull_requests").get()).toEqual({
    merged_head: "h1",
    merge_commit: "m1",
  });
  expect(db.query("SELECT launch_id, step, state FROM cleanups").all()).toEqual([
    { launch_id: "l1", step: "remote_branch", state: "pending" },
  ]);
  expect(db.query("SELECT state FROM sources").get()).toEqual({ state: "open" });
  // A repeated record of the same merge is unchanged and adds no second cleanup.
  expect(recordPullRequestMerge(db, "l1", merge, sourceState)).toMatchObject({
    value: { changed: false },
  });
  expect(db.query("SELECT COUNT(*) AS count FROM cleanups").get()).toEqual({ count: 1 });
});

test("the last merge finishes the source, and a merge without its PR changes nothing", () => {
  using db = fixture(["change"]);
  expect(recordPullRequestMerge(db, "l1", merge, sourceState)).toMatchObject({
    error: { reason: "pr_not_associated" },
  });
  associate(db);
  expect(recordPullRequestMerge(db, "l1", { ...merge, number: 8 }, sourceState)).toMatchObject({
    error: { reason: "pr_not_associated" },
  });
  expect(db.query("SELECT COUNT(*) AS count FROM cleanups").get()).toEqual({ count: 0 });
  expect(recordPullRequestMerge(db, "l1", merge, sourceState).tag).toBe("Ok");
  expect(db.query("SELECT state, ended_at IS NOT NULL AS ended FROM sources").get()).toEqual({
    state: "finished",
    ended: 1,
  });
});

test("one process claims a cleanup, advances only its own claim, and a stopped claim is taken over", () => {
  using db = fixture();
  associate(db);
  recordPullRequestMerge(db, "l1", merge, sourceState);
  expect(claimCleanup(db, "owner/other", "s1", "change")).toMatchObject({
    error: { reason: "source_not_found" },
  });
  expect(claimCleanup(db, "owner/one", "s1", "other")).toMatchObject({
    error: { reason: "cleanup_not_found" },
  });
  expect(claimCleanup(db, "owner/one", "s1", "change")).toMatchObject({
    tag: "Ok",
    value: {
      cleanup: { step: "remote_branch", ownerPid: process.pid },
      pullRequest: { mergedHead: "h1", branch: "task/change" },
      launch: { id: "l1", paneId: "p1" },
      checkout: "/one",
    },
  });
  // The claiming process renews its own lease.
  db.exec("UPDATE cleanups SET lease_at = '2000-01-01T00:00:00.000Z'");
  renewCleanup(db, "s1", "change");
  expect(db.query("SELECT lease_at > '2001' AS fresh FROM cleanups").get()).toEqual({ fresh: 1 });
  const other = Bun.spawn([process.execPath, "-e", "await Bun.sleep(5000)"]);
  try {
    db.query("UPDATE cleanups SET owner_pid = ?").run(other.pid);
    expect(claimCleanup(db, "owner/one", "s1", "change")).toMatchObject({
      error: { reason: "cleanup_running" },
    });
    // A stale lease ends the claim, even while its process still exists.
    db.exec("UPDATE cleanups SET lease_at = '2000-01-01T00:00:00.000Z'");
    expect(claimCleanup(db, "owner/one", "s1", "change").tag).toBe("Ok");
  } finally {
    other.kill();
  }
  const gone = Bun.spawnSync([process.execPath, "--version"]).pid;
  db.query("UPDATE cleanups SET owner_pid = ?").run(gone);
  // Another process's claim is not advanced by this one.
  advanceCleanup(db, "s1", "change", {
    step: null,
    state: "done",
    reason: null,
    detail: null,
    release: true,
  });
  expect(db.query("SELECT state FROM cleanups").get()).toEqual({ state: "pending" });
  expect(claimCleanup(db, "owner/one", "s1", "change").tag).toBe("Ok");
  advanceCleanup(db, "s1", "change", {
    step: "pane",
    state: "failed",
    reason: "cleanup_failed",
    detail: "pane: herdr_failed",
    release: true,
  });
  expect(db.query("SELECT step, state, owner_pid FROM cleanups").get()).toEqual({
    step: "pane",
    state: "failed",
    owner_pid: null,
  });
});

test("an open cleanup keeps the project registered after its source finished", () => {
  using db = fixture(["change"]);
  associate(db);
  recordPullRequestMerge(db, "l1", merge, sourceState);
  expect(removeProject(db, "owner/one")).toMatchObject({
    error: { reason: "project_cleanup_open" },
  });
  db.exec("UPDATE cleanups SET step = NULL, state = 'done'");
  expect(removeProject(db, "owner/one").tag).toBe("Ok");
  expect(db.query("SELECT COUNT(*) AS count FROM cleanups").get()).toEqual({ count: 0 });
});

test("the merge records its cleanup process, which alone may claim it while it runs", () => {
  using db = fixture();
  associate(db);
  recordPullRequestMerge(db, "l1", merge, sourceState);
  const other = Bun.spawn([process.execPath, "-e", "await Bun.sleep(5000)"]);
  try {
    startCleanup(db, "s1", "change", other.pid);
    expect(db.query("SELECT owner_pid FROM cleanups").get()).toEqual({ owner_pid: other.pid });
    // Another process, such as a SuperAgent retry, sees it running.
    expect(claimCleanup(db, "owner/one", "s1", "change")).toMatchObject({
      error: { reason: "cleanup_running" },
    });
    // The started process itself takes the claim.
    db.query("UPDATE cleanups SET owner_pid = ?").run(process.pid);
    expect(claimCleanup(db, "owner/one", "s1", "change").tag).toBe("Ok");
    // A claimed or ended cleanup keeps its owner.
    startCleanup(db, "s1", "change", other.pid);
    expect(db.query("SELECT owner_pid FROM cleanups").get()).toEqual({ owner_pid: process.pid });
  } finally {
    other.kill();
  }
});
