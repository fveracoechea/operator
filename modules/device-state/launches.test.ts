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
  ownerGone,
  readPreparation,
  reserveLaunch,
  updateLaunch,
} from "./launches.ts";

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
  expect(updateLaunch(db, "l1", { state: "failed", failureReason: "herdr_failed" })).toMatchObject({
    value: { state: "failed", paneId: "w1:p2" },
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

test("a start owned by a stopped process or with a stale lease is abandoned", () => {
  const now = Date.now();
  const fresh = new Date(now).toISOString();
  expect(ownerGone({ ownerPid: process.pid, leaseAt: fresh }, now)).toBe(false);
  expect(ownerGone({ ownerPid: stoppedPid, leaseAt: fresh }, now)).toBe(true);
  expect(
    ownerGone({ ownerPid: process.pid, leaseAt: new Date(now - 300001).toISOString() }, now),
  ).toBe(true);
  expect(ownerGone({ ownerPid: null, leaseAt: fresh }, now)).toBe(true);
});

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
  ).toMatchObject({ value: { launches: ["l1"] } });
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
