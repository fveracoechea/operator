import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { migrationsFolder } from "./database.ts";
import { registerSource } from "./sources.ts";
import { registerProject, removeProject } from "./projects.ts";
import {
  beginPreparation,
  finishPreparation,
  launchNames,
  observePane,
  readPreparation,
  renewLaunch,
  renewPreparation,
  reserveLaunch,
  updateLaunch,
} from "./launches.ts";
import { busy, insertRow, reservedCopy } from "./state-fixture.ts";

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
    [{ sourceId: "s1", key: "read", completion: "report", state: "ready" }],
  );
  return db;
}

const launch = {
  id: "l1",
  sourceId: "s1",
  assignment: "read",
  state: "starting",
  name: "report-app-1-read",
  resources: "pane",
  branch: null,
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

function state(db: Database) {
  return db.query("SELECT state FROM assignments").get();
}

test("a reservation starts the assignment once and refuses a second dispatch", () => {
  using db = fixture();
  expect(reserveLaunch(db, "/other", "owner/one", launch)).toMatchObject({
    error: { reason: "controller_mismatch" },
  });
  expect(reserveLaunch(db, "/one", "owner/one", launch)).toMatchObject({
    tag: "Ok",
    value: { attempt: 1 },
  });
  expect(state(db)).toEqual({ state: "running" });
  expect(reserveLaunch(db, "/one", "owner/one", { ...launch, id: "l2", name: "x" })).toMatchObject({
    error: { reason: "assignment_not_dispatchable" },
  });
  expect(launchNames(db)).toMatchObject({ value: ["report-app-1-read"] });
});

test("only a failed or interrupted launch permits a replacement with a new attempt and name", () => {
  using db = fixture();
  reserveLaunch(db, "/one", "owner/one", launch);
  expect(updateLaunch(db, "l1", { paneId: "w1:p2", workspaceId: "w1" })).toMatchObject({
    tag: "Ok",
  });
  const failed = updateLaunch(db, "l1", { state: "failed", failureReason: "herdr_failed" });
  expect(failed).toMatchObject({ value: { state: "failed", paneId: "w1:p2" } });
  // A failed start ends when its outcome is recorded.
  expect(failed.getOrNull()?.endedAt).toBe(failed.getOrNull()?.leaseAt);
  expect(db.query("SELECT ended_at IS NOT NULL AS ended FROM launches").get()).toEqual({
    ended: 1,
  });
  expect(updateLaunch(db, "l1", { state: "running" })).toMatchObject({
    error: { reason: "launch_not_starting" },
  });
  expect(reserveLaunch(db, "/one", "owner/one", { ...launch, id: "l2" })).toMatchObject({
    error: { reason: "launch_name_taken" },
  });
  expect(
    reserveLaunch(db, "/one", "owner/one", { ...launch, id: "l2", name: "report-app-1-read-2" }),
  ).toMatchObject({ value: { attempt: 2 } });
});

// A process that already exited has an identifier that no live process holds.
const stoppedPid = Bun.spawnSync([process.execPath, "--version"]).pid;

test("a replacement ends an abandoned start and takes the next attempt", () => {
  using db = fixture();
  reserveLaunch(db, "/one", "owner/one", launch);
  const next = { ...launch, id: "l2", name: "report-app-1-read-2" };
  expect(reserveLaunch(db, "/one", "owner/one", next)).toMatchObject({
    error: { reason: "assignment_not_dispatchable" },
  });
  db.query("UPDATE launches SET owner_pid = ?").run(stoppedPid);
  expect(reserveLaunch(db, "/one", "owner/one", next)).toMatchObject({ value: { attempt: 2 } });
  expect(db.query("SELECT state, failure_reason FROM launches WHERE id = 'l1'").get()).toEqual({
    state: "failed",
    failure_reason: "launch_abandoned",
  });
  expect(updateLaunch(db, "l1", { state: "running" })).toMatchObject({
    error: { reason: "launch_not_starting" },
  });
});

test("a pane exit during the start interrupts the starting launch", () => {
  using db = fixture();
  reserveLaunch(db, "/one", "owner/one", launch);
  updateLaunch(db, "l1", { paneId: "w1:p2" });
  expect(
    observePane(db, {
      paneId: "w1:p2",
      workspaceId: "w1",
      socket: "/herdr.sock",
      observation: { exited: true },
    }),
  ).toMatchObject({ value: { launches: ["l1"] } });
  expect(updateLaunch(db, "l1", { state: "running" })).toMatchObject({
    error: { reason: "launch_not_starting" },
  });
  expect(db.query("SELECT state FROM launches").get()).toEqual({ state: "interrupted" });
});

test("pane observations match only running launches of the same Herdr server", () => {
  using db = fixture();
  reserveLaunch(db, "/one", "owner/one", launch);
  updateLaunch(db, "l1", { paneId: "w1:p2", state: "running" });
  const pane = { paneId: "w1:p2", workspaceId: "w1" };
  expect(
    observePane(db, { ...pane, socket: "/other.sock", observation: { exited: true } }),
  ).toMatchObject({ value: { launches: [] } });
  expect(
    observePane(db, {
      ...pane,
      socket: "/herdr.sock",
      observation: { exited: false, activity: "done" },
    }),
  ).toMatchObject({ value: { launches: ["l1"], reviewers: [] } });
  expect(db.query("SELECT state, activity FROM launches").get()).toEqual({
    state: "running",
    activity: "done",
  });
  expect(
    observePane(db, { ...pane, socket: "/herdr.sock", observation: { exited: true } }),
  ).toMatchObject({ value: { launches: ["l1"] } });
  expect(db.query("SELECT state, failure_reason FROM launches").get()).toEqual({
    state: "interrupted",
    failure_reason: "pane_ended",
  });
  expect(state(db)).toEqual({ state: "running" });
});

test("a preparation runs once at a time and records its finished outcome", () => {
  using db = fixture();
  expect(readPreparation(db, "/wt")).toMatchObject({ value: null });
  expect(beginPreparation(db, "/wt", "owner/one")).toMatchObject({ value: { state: "running" } });
  expect(beginPreparation(db, "/wt", "owner/one")).toMatchObject({
    error: { reason: "preparation_running" },
  });
  expect(readPreparation(db, "/wt")).toMatchObject({ value: { abandoned: false } });
  // A hook that was killed leaves its row running. Its stopped owner releases the path.
  db.query("UPDATE worktree_preparations SET owner_pid = ?").run(stoppedPid);
  expect(readPreparation(db, "/wt")).toMatchObject({ value: { abandoned: true } });
  expect(beginPreparation(db, "/wt", "owner/one")).toMatchObject({
    value: { state: "running", ownerPid: process.pid },
  });
  finishPreparation(db, "/wt", { state: "failed", detail: "lockfile" });
  expect(readPreparation(db, "/wt")).toMatchObject({
    value: { state: "failed", detail: "lockfile" },
  });
  expect(beginPreparation(db, "/wt", "owner/one")).toMatchObject({ value: { state: "running" } });
});

test("project removal deletes its launches and preparations with its sources", () => {
  using db = fixture();
  reserveLaunch(db, "/one", "owner/one", launch);
  updateLaunch(db, "l1", { state: "failed" });
  beginPreparation(db, "/wt", "owner/one");
  db.exec(
    "UPDATE assignments SET state = 'abandoned'; UPDATE sources SET state = 'reset', ended_at = 'now'",
  );
  expect(removeProject(db, "owner/one").tag).toBe("Ok");
  expect(db.query("SELECT count(*) AS count FROM launches").get()).toEqual({ count: 0 });
  expect(db.query("SELECT count(*) AS count FROM worktree_preparations").get()).toEqual({
    count: 0,
  });
});

function reserveAgain(db: Database, attempt: number) {
  return reserveLaunch(db, "/one", "owner/one", {
    ...launch,
    id: `l${attempt}`,
    name: `report-app-1-read-${attempt}`,
  });
}

test("a running, PR-open, or returned assignment starts again only after its latest start ended", () => {
  for (const [assignmentState, latest, decision, allowed] of [
    ["running", "failed", null, true],
    ["running", "interrupted", null, true],
    ["pr-open", "failed", null, true],
    ["pr-open", "finished", null, false],
    ["reported", "interrupted", "returned", true],
    ["reported", "interrupted", "accepted", false],
    ["reported", "interrupted", null, false],
    ["completed", "failed", null, false],
    ["completed", "interrupted", "returned", false],
    ["abandoned", "interrupted", null, false],
  ] as const) {
    using db = fixture();
    reserveLaunch(db, "/one", "owner/one", launch);
    db.query("UPDATE launches SET state = ?").run(latest);
    db.query("UPDATE assignments SET state = ?").run(assignmentState);
    if (decision !== null) {
      // An older returned report does not count once a later report has another decision.
      insertRow(db, "reports", {
        source_id: "s1",
        assignment: "read",
        launch_id: "l1",
        number: 1,
        decision: "returned",
      });
      insertRow(db, "reports", {
        source_id: "s1",
        assignment: "read",
        launch_id: "l1",
        number: 2,
        decision,
      });
    }
    const label = `${assignmentState} ${latest} ${decision}`;
    const result = reserveAgain(db, 2);
    if (allowed) {
      expect(result, label).toMatchObject({ tag: "Ok", value: { attempt: 2 } });
      // A returned report resumes as running, and other states keep their state.
      expect(state(db), label).toEqual({
        state: assignmentState === "reported" ? "running" : assignmentState,
      });
    } else
      expect(result, label).toMatchObject({
        tag: "Err",
        error: {
          reason: "assignment_not_dispatchable",
          detail:
            "Assignment read changed before dispatch. Read next actions again. Nothing was launched.",
        },
      });
  }
});

test("a reservation names each refusal and records an abandoned start's end", () => {
  using db = fixture();
  for (const repository of ["owner/unregistered", "owner/one"])
    expect(reserveLaunch(db, "/other", repository, launch)).toMatchObject({
      tag: "Err",
      error: {
        reason: "controller_mismatch",
        detail: "The controlling checkout changed before dispatch. Read the project again.",
      },
    });
  expect(reserveLaunch(db, "/one", "owner/one", { ...launch, sourceId: "missing" })).toMatchObject({
    tag: "Err",
    error: { reason: "source_not_found", detail: "The source does not exist in this project." },
  });
  expect(
    reserveLaunch(db, "/one", "owner/one", { ...launch, assignment: "missing" }),
  ).toMatchObject({
    tag: "Err",
    error: { reason: "assignment_not_dispatchable" },
  });
  db.exec("UPDATE sources SET state = 'reset'");
  expect(reserveLaunch(db, "/one", "owner/one", launch)).toMatchObject({
    tag: "Err",
    error: { reason: "assignment_not_dispatchable" },
  });
  db.exec("UPDATE sources SET state = 'open'");
  reserveLaunch(db, "/one", "owner/one", launch);
  updateLaunch(db, "l1", { state: "failed" });
  expect(reserveLaunch(db, "/one", "owner/one", { ...launch, id: "l2" })).toMatchObject({
    tag: "Err",
    error: {
      reason: "launch_name_taken",
      detail: "The launch name report-app-1-read is already recorded. Nothing was launched.",
    },
  });
  db.exec("UPDATE launches SET state = 'starting'");
  db.query("UPDATE launches SET owner_pid = ?").run(stoppedPid);
  expect(reserveAgain(db, 2).tag).toBe("Ok");
  expect(
    db
      .query("SELECT failure_detail, ended_at IS NOT NULL AS ended FROM launches WHERE id = 'l1'")
      .get(),
  ).toEqual({
    failure_detail:
      "The dispatching process stopped before it recorded a launch outcome. Its recorded resources stay.",
    ended: 1,
  });
});

test("an update ends only a failed start, and an unknown launch is not starting", () => {
  using db = fixture();
  reserveLaunch(db, "/one", "owner/one", launch);
  expect(updateLaunch(db, "l1", { paneId: "p1" })).toMatchObject({ value: { endedAt: null } });
  expect(updateLaunch(db, "l1", { state: "running" })).toMatchObject({
    value: { state: "running", endedAt: null },
  });
  expect(db.query("SELECT ended_at FROM launches").get()).toEqual({ ended_at: null });
  expect(updateLaunch(db, "missing", { state: "running" })).toMatchObject({
    tag: "Err",
    error: {
      reason: "launch_not_starting",
      detail: "Only a starting launch can record resources or its launch outcome.",
    },
  });
});

test("only the owner renews a starting launch or a running preparation", () => {
  using db = fixture();
  reserveLaunch(db, "/one", "owner/one", launch);
  beginPreparation(db, "/wt", "owner/one");
  const old = "2000-01-01T00:00:00.000Z";
  function leases() {
    return [
      db.query("SELECT lease_at FROM launches").get(),
      db.query("SELECT lease_at FROM worktree_preparations").get(),
    ];
  }
  db.query("UPDATE launches SET lease_at = ?, owner_pid = ?").run(old, stoppedPid);
  db.query("UPDATE worktree_preparations SET lease_at = ?, owner_pid = ?").run(old, stoppedPid);
  expect(renewLaunch(db, "l1").tag).toBe("Ok");
  expect(renewPreparation(db, "/wt").tag).toBe("Ok");
  expect(leases()).toEqual([{ lease_at: old }, { lease_at: old }]);
  db.query("UPDATE launches SET owner_pid = ?").run(process.pid);
  db.query("UPDATE worktree_preparations SET owner_pid = ?").run(process.pid);
  renewLaunch(db, "l1");
  renewPreparation(db, "/wt");
  expect([
    db.query("SELECT lease_at > '2001' AS fresh FROM launches").get(),
    db.query("SELECT lease_at > '2001' AS fresh FROM worktree_preparations").get(),
  ]).toEqual([{ fresh: 1 }, { fresh: 1 }]);
  db.query("UPDATE launches SET lease_at = ?, state = 'running'").run(old);
  db.query("UPDATE worktree_preparations SET lease_at = ?, state = 'prepared'").run(old);
  renewLaunch(db, "l1");
  renewPreparation(db, "/wt");
  expect(leases()).toEqual([{ lease_at: old }, { lease_at: old }]);
});

test("launch names include named reviewers only", () => {
  using db = fixture();
  reserveLaunch(db, "/one", "owner/one", launch);
  insertRow(db, "review_requests", { id: "r1", repository: "owner/one", name: "one-pr7-review" });
  insertRow(db, "review_requests", { id: "r2", repository: "owner/one", name: null });
  expect(launchNames(db)).toMatchObject({
    tag: "Ok",
    value: ["report-app-1-read", "one-pr7-review"],
  });
});

test("a pane exit interrupts a running reviewer on the same server, and activity changes no reviewer", () => {
  using db = fixture();
  function reviewerRow(id: string, socket: string | null, launchState: string) {
    insertRow(db, "review_requests", {
      id,
      repository: "owner/one",
      number: Number(id.slice(1)),
      state: "reviewing",
      pane_id: "w1:p9",
      herdr_socket: socket,
      launch_state: launchState,
    });
  }
  reviewerRow("r1", null, "running");
  reviewerRow("r2", "/herdr.sock", "running");
  reviewerRow("r3", null, "starting");
  const pane = { paneId: "w1:p9", workspaceId: "w1" };
  expect(
    observePane(db, { ...pane, socket: null, observation: { exited: false, activity: "busy" } }),
  ).toMatchObject({ tag: "Ok", value: { launches: [], reviewers: [] } });
  expect(db.query("SELECT launch_state FROM review_requests ORDER BY id").all()).toEqual([
    { launch_state: "running" },
    { launch_state: "running" },
    { launch_state: "starting" },
  ]);
  // A reviewer with no recorded server does not match an observation from a server.
  expect(
    observePane(db, { ...pane, socket: "/other.sock", observation: { exited: true } }),
  ).toMatchObject({ tag: "Ok", value: { launches: [], reviewers: [] } });
  expect(observePane(db, { ...pane, socket: null, observation: { exited: true } })).toMatchObject({
    tag: "Ok",
    value: { launches: [], reviewers: ["r1"] },
  });
  expect(db.query("SELECT id, launch_state FROM review_requests ORDER BY id").all()).toEqual([
    { id: "r1", launch_state: "interrupted" },
    { id: "r2", launch_state: "running" },
    { id: "r3", launch_state: "starting" },
  ]);
});

test("a launch with no recorded server matches only an observation with no server", () => {
  using db = fixture();
  reserveLaunch(db, "/one", "owner/one", { ...launch, herdrSocket: null });
  updateLaunch(db, "l1", { paneId: "w1:p2", state: "running" });
  const pane = { paneId: "w1:p2", workspaceId: "w1", observation: { exited: true } } as const;
  expect(observePane(db, { ...pane, socket: "/herdr.sock" })).toMatchObject({
    value: { launches: [], reviewers: [] },
  });
  expect(observePane(db, { ...pane, socket: null })).toMatchObject({
    value: { launches: ["l1"], reviewers: [] },
  });
  expect(db.query("SELECT state, failure_reason, failure_detail FROM launches").get()).toEqual({
    state: "interrupted",
    failure_reason: "pane_ended",
    failure_detail:
      "Herdr reported that pane w1:p2 exited or closed before the assignment completed.",
  });
});

test("a preparation names its running path, and a finished one is not abandoned", () => {
  using db = fixture();
  expect(beginPreparation(db, "/wt", "owner/one")).toMatchObject({
    value: {
      path: "/wt",
      repository: "owner/one",
      state: "running",
      detail: "Preparation started.",
      finishedAt: null,
    },
  });
  expect(beginPreparation(db, "/wt", "owner/one")).toMatchObject({
    tag: "Err",
    error: {
      reason: "preparation_running",
      detail: "Another preparation of /wt is still running.",
    },
  });
  finishPreparation(db, "/wt", { state: "prepared", detail: "done" });
  db.query("UPDATE worktree_preparations SET owner_pid = ?").run(stoppedPid);
  expect(readPreparation(db, "/wt")).toMatchObject({
    value: { state: "prepared", abandoned: false },
  });
});

test("reads and unmatched pane events need no writer reservation, and launch changes wait for it", () => {
  using db = fixture();
  beginPreparation(db, "/wt", "owner/one");
  using reserved = reservedCopy(db);
  const subject = reserved.subject;
  expect(launchNames(subject).tag).toBe("Ok");
  expect(readPreparation(subject, "/wt").tag).toBe("Ok");
  expect(
    observePane(subject, {
      paneId: "none",
      workspaceId: null,
      socket: null,
      observation: { exited: true },
    }),
  ).toMatchObject({ tag: "Ok", value: { launches: [], reviewers: [] } });
  expect(reserveLaunch(subject, "/other", "owner/one", launch)).toMatchObject(busy);
  expect(updateLaunch(subject, "missing", { state: "running" })).toMatchObject(busy);
  expect(beginPreparation(subject, "/wt", "owner/one")).toMatchObject(busy);
});
