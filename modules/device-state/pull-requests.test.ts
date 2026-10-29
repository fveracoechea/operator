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
  recordPullRequestMerge,
  recordPullRequestWait,
  renewPullRequestRelay,
  renewPullRequestWait,
  worktreeOwners,
} from "./pull-requests.ts";
import { busy, reservedCopy } from "./state-fixture.ts";

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

function launchRow(id: string, assignment: string) {
  return {
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
  };
}

function start(db: Database, id: string, assignment: string, paneId: string) {
  const reserved = reserveLaunch(db, "/one", "owner/one", launchRow(id, assignment));
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

const pr = {
  number: 7,
  url: "https://github.com/owner/one/pull/7",
  branch: "task/change",
  relay: null,
};

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

test("a stacked PR keeps its relay record, and only another live process holds its claim", () => {
  using db = fixture();
  start(db, "l1", "change", "p1");
  const relay = { state: "stacked", ownerPid: null, leaseAt: null };
  associatePullRequest(db, "l1", { ...pr, relay: JSON.stringify(relay) });
  const held: boolean[] = [];
  function claim(ownerPid: number | null, leaseAt = new Date().toISOString()) {
    db.query("UPDATE pull_requests SET relay = ?").run(
      JSON.stringify({ ...relay, ownerPid, leaseAt }),
    );
    recordPullRequestWait(db, "l1", (row) => {
      held.push(row.relayHeld);
      return { progress: row.progress, waitState: row.waitState, relay: '{"state":"relayed"}' };
    });
  }
  const gone = Bun.spawnSync([process.execPath, "--version"]).pid;
  const other = Bun.spawn([process.execPath, "-e", "await Bun.sleep(5000)"]);
  try {
    claim(null);
    claim(process.pid);
    claim(gone);
    claim(other.pid, "2000-01-01T00:00:00.000Z");
    claim(other.pid);
  } finally {
    other.kill();
  }
  expect(held).toEqual([false, false, false, false, true]);
  expect(db.query("SELECT relay FROM pull_requests").get()).toEqual({
    relay: '{"state":"relayed"}',
  });
});

test("a relay renews only its own claim, so a slow relay is not taken over", () => {
  using db = fixture();
  start(db, "l1", "change", "p1");
  const old = "2000-01-01T00:00:00.000Z";
  function claim(ownerPid: number) {
    db.query("DELETE FROM pull_requests").run();
    associatePullRequest(db, "l1", {
      ...pr,
      relay: JSON.stringify({ state: "stacked", ownerPid, leaseAt: old }),
    });
    expect(renewPullRequestRelay(db, "s1", "change").tag).toBe("Ok");
    const row = db.query("SELECT relay FROM pull_requests").get() as { relay: string };
    return (JSON.parse(row.relay) as { leaseAt: string }).leaseAt;
  }
  expect(claim(process.pid)).not.toBe(old);
  expect(claim(process.pid + 1)).toBe(old);
});

const merge = { number: 7, head: "h1", mergeCommit: "m1" };

test("worktree owners list each assignment of each source once", () => {
  using db = fixture();
  registerSource(
    db,
    "/one",
    {
      id: "s2",
      repository: "owner/one",
      trackerKey: "APP-2",
      state: "open",
      registeredAt: "now",
      endedAt: null,
      plan: "{}",
    },
    [{ sourceId: "s2", key: "change", completion: "pr", state: "ready" }],
  );
  start(db, "l1", "change", "p1");
  start(db, "l2", "other", "p2");
  reserveLaunch(db, "/one", "owner/one", {
    ...launchRow("l3", "change"),
    sourceId: "s2",
  });
  updateLaunch(db, "l3", { paneId: "p3", worktreePath: "/worktrees/s2", state: "running" });
  const owners = worktreeOwners(db).getOrNull() ?? [];
  expect(
    owners.map((row) => `${row.sourceId}/${row.assignment}/${row.launchId}`).toSorted(),
  ).toEqual(["s1/change/l1", "s1/other/l2", "s2/change/l3"]);
});

test("an owner is inactive when a newer start exists, its source ended, or it is not a PR assignment", () => {
  using db = fixture();
  start(db, "l1", "change", "p1");
  const inactive = {
    tag: "Err",
    error: {
      reason: "pr_owner_inactive",
      detail:
        "This worktree no longer belongs to the running owner of an open PR assignment. Nothing was changed.",
    },
  };
  // A newer start replaces this owner even while the older launch still reads as running.
  db.exec(
    "INSERT INTO launches (id, source_id, assignment, attempt, state, name, resources, host, model, requested_model, reasoning_effort, release, skills, started_at) SELECT 'l9', source_id, assignment, 2, 'starting', 'n9', resources, host, model, requested_model, reasoning_effort, release, skills, started_at FROM launches WHERE id = 'l1'",
  );
  expect(associatePullRequest(db, "l1", pr)).toMatchObject(inactive);
  db.exec("DELETE FROM launches WHERE id = 'l9'");
  db.exec("UPDATE sources SET state = 'reset'");
  expect(associatePullRequest(db, "l1", pr)).toMatchObject(inactive);
  db.exec(
    "UPDATE sources SET state = 'open'; UPDATE assignments SET state = 'completed' WHERE key = 'change'",
  );
  expect(associatePullRequest(db, "l1", pr)).toMatchObject(inactive);
  db.exec("UPDATE assignments SET state = 'running' WHERE key = 'change'");
  expect(associatePullRequest(db, "l1", pr).tag).toBe("Ok");
});

test("association records idle progress, names the owning PR, and asks for a review only when told", () => {
  using db = fixture();
  start(db, "l1", "change", "p1");
  start(db, "l2", "other", "p2");
  expect(associatePullRequest(db, "l1", pr)).toMatchObject({
    tag: "Ok",
    value: {
      changed: true,
      row: {
        sourceId: "s1",
        assignment: "change",
        progress: '{"seen":[],"failures":[],"eligibleHead":null}',
        waitState: "idle",
        mergedHead: null,
      },
    },
  });
  expect(db.query("SELECT * FROM review_requests").all()).toEqual([]);
  expect(associatePullRequest(db, "l1", { ...pr, number: 8 })).toMatchObject({
    tag: "Err",
    error: {
      reason: "pr_already_associated",
      detail: "Assignment change already owns PR #7. Nothing was changed.",
    },
  });
  expect(associatePullRequest(db, "l2", pr)).toMatchObject({
    tag: "Err",
    error: {
      reason: "pr_owned_elsewhere",
      detail: "PR #7 belongs to another open PR assignment. Nothing was changed.",
    },
  });
  const other = {
    number: 9,
    url: "https://github.com/owner/one/pull/9",
    branch: "task/other",
    relay: null,
  };
  expect(associatePullRequest(db, "l2", other, true).tag).toBe("Ok");
  expect(
    db
      .query(
        "SELECT repository, number, url, source_id, assignment, origin, state FROM review_requests",
      )
      .all(),
  ).toEqual([
    {
      repository: "owner/one",
      number: 9,
      url: other.url,
      source_id: "s1",
      assignment: "other",
      origin: "assignment",
      state: "queued",
    },
  ]);
});

test("a wait needs the PR row and the PR open state, and names a missing branch", () => {
  using db = fixture();
  start(db, "l1", "change", "p1");
  const missing = {
    tag: "Err",
    error: {
      reason: "pr_not_associated",
      detail: "Run operator pr associate after you open the PR. Nothing was changed.",
    },
  };
  db.exec("UPDATE assignments SET state = 'pr-open' WHERE key = 'change'");
  expect(recordPullRequestWait(db, "l1", () => null)).toMatchObject(missing);
  db.exec("UPDATE assignments SET state = 'running' WHERE key = 'change'");
  associatePullRequest(db, "l1", pr);
  db.exec("UPDATE assignments SET state = 'running' WHERE key = 'change'");
  expect(recordPullRequestWait(db, "l1", () => null)).toMatchObject(missing);
  db.exec(
    "UPDATE assignments SET state = 'pr-open' WHERE key = 'change'; UPDATE launches SET branch = NULL",
  );
  expect(recordPullRequestWait(db, "l1", () => null)).toMatchObject({
    tag: "Err",
    error: {
      reason: "pr_branch_mismatch",
      detail: "This launch is on no branch, but PR #7 is on task/change. Nothing was changed.",
    },
  });
  db.exec("UPDATE launches SET branch = 'task/change'");
  const held: boolean[] = [];
  recordPullRequestWait(db, "l1", (row) => {
    held.push(row.relayHeld);
    return null;
  });
  // A PR with no relay has no claim to hold.
  expect(held).toEqual([false]);
});

test("a verified merge records the merge, the merged state, the cleanup, and the source decision once", () => {
  using db = fixture();
  start(db, "l1", "change", "p1");
  associatePullRequest(db, "l1", pr);
  const seen: unknown[] = [];
  expect(
    recordPullRequestMerge(db, "l1", merge, (rows) => {
      seen.push(rows);
      return "open";
    }),
  ).toMatchObject({ tag: "Ok", value: { changed: true } });
  expect(seen).toEqual([
    [
      { key: "change", completion: "pr", state: "merged" },
      { key: "other", completion: "pr", state: "ready" },
      { key: "read", completion: "report", state: "ready" },
    ],
  ]);
  expect(
    db
      .query("SELECT merged_head, merge_commit, merged_at IS NOT NULL AS at FROM pull_requests")
      .get(),
  ).toEqual({
    merged_head: "h1",
    merge_commit: "m1",
    at: 1,
  });
  expect(assignmentState(db, "change")).toEqual({ state: "merged" });
  expect(
    db
      .query(
        "SELECT source_id, assignment, launch_id, step, state, reason, detail, owner_pid, lease_at FROM cleanups",
      )
      .all(),
  ).toEqual([
    {
      source_id: "s1",
      assignment: "change",
      launch_id: "l1",
      step: "remote_branch",
      state: "pending",
      reason: null,
      detail: null,
      owner_pid: null,
      lease_at: null,
    },
  ]);
  // The decision kept the source open, so it has no end.
  expect(db.query("SELECT state, ended_at FROM sources").get()).toEqual({
    state: "open",
    ended_at: null,
  });
  expect(recordPullRequestMerge(db, "l1", merge, () => "finished")).toMatchObject({
    tag: "Ok",
    value: { changed: false },
  });
  // Another PR number on the merged assignment is no repeat, and its owner is no longer active.
  expect(recordPullRequestMerge(db, "l1", { ...merge, number: 8 }, () => "finished")).toMatchObject(
    {
      tag: "Err",
      error: { reason: "pr_owner_inactive" },
    },
  );
  expect(db.query("SELECT state FROM sources").get()).toEqual({ state: "open" });
});

test("a merge that the source decision ends finishes the source", () => {
  using db = fixture();
  start(db, "l1", "change", "p1");
  associatePullRequest(db, "l1", pr);
  expect(recordPullRequestMerge(db, "l1", merge, () => "finished").tag).toBe("Ok");
  expect(db.query("SELECT state, ended_at IS NOT NULL AS ended FROM sources").get()).toEqual({
    state: "finished",
    ended: 1,
  });
});

test("a merge refuses an unknown launch, an unassociated PR, another PR number, and a left PR state", () => {
  using db = fixture();
  start(db, "l1", "change", "p1");
  expect(recordPullRequestMerge(db, "missing", merge, () => "open")).toMatchObject({
    error: { reason: "pr_owner_inactive" },
  });
  function notOpen(number: number) {
    return {
      tag: "Err",
      error: {
        reason: "pr_not_associated",
        detail: `PR #${number} is not the open PR of assignment change. Nothing was changed.`,
      },
    };
  }
  expect(recordPullRequestMerge(db, "l1", merge, () => "open")).toMatchObject(notOpen(7));
  // A PR open state without its PR record is still no associated PR.
  db.exec("UPDATE assignments SET state = 'pr-open' WHERE key = 'change'");
  expect(recordPullRequestMerge(db, "l1", merge, () => "open")).toMatchObject(notOpen(7));
  db.exec("UPDATE assignments SET state = 'running' WHERE key = 'change'");
  associatePullRequest(db, "l1", pr);
  expect(recordPullRequestMerge(db, "l1", { ...merge, number: 8 }, () => "open")).toMatchObject(
    notOpen(8),
  );
  db.exec("UPDATE assignments SET state = 'running' WHERE key = 'change'");
  expect(recordPullRequestMerge(db, "l1", merge, () => "open")).toMatchObject(notOpen(7));
  expect(db.query("SELECT COUNT(*) AS count FROM cleanups").get()).toEqual({ count: 0 });
  expect(db.query("SELECT merged_head FROM pull_requests").get()).toEqual({ merged_head: null });
});

test("reads need no writer reservation, and PR changes wait for it even when they refuse", () => {
  using db = fixture();
  using reserved = reservedCopy(db);
  expect(worktreeOwners(reserved.subject).tag).toBe("Ok");
  expect(associatePullRequest(reserved.subject, "missing", pr)).toMatchObject(busy);
  expect(recordPullRequestWait(reserved.subject, "missing", () => null)).toMatchObject(busy);
  expect(recordPullRequestMerge(reserved.subject, "missing", merge, () => "open")).toMatchObject(
    busy,
  );
});
