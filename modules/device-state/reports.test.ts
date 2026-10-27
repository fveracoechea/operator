import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { Err, Ok } from "unthrown";
import { migrationsFolder } from "./database.ts";
import { registerSource } from "./sources.ts";
import { registerProject } from "./projects.ts";
import { observePane, reserveLaunch, updateLaunch } from "./launches.ts";
import { changeReport, readReport, type ReportRow } from "./reports.ts";

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

const row: ReportRow = {
  sourceId: "s1",
  assignment: "read",
  number: 1,
  launchId: "l1",
  submittedAt: "now",
  conclusion: "Done.",
  evidence: "[]",
  unresolved: "[]",
  decisions: "[]",
  files: "[]",
  decision: null,
  decidedAt: null,
  followUp: null,
  cleanupState: null,
  cleanupDetail: null,
};

function running(db: Database) {
  reserveLaunch(db, "/one", "owner/one", launch);
  updateLaunch(db, "l1", { paneId: "w1:p1" });
  updateLaunch(db, "l1", { state: "running" });
}

const pane = { by: "pane", socket: "/herdr.sock", paneId: "w1:p1" } as const;
const key = {
  by: "key",
  repository: "owner/one",
  checkout: "/one",
  sourceId: "s1",
  assignment: "read",
} as const;

test("a worker is found only by a live launch on its own pane and Herdr server", () => {
  using db = fixture();
  expect(readReport(db, pane)).toMatchObject({ error: { reason: "worker_launch_not_found" } });
  running(db);
  expect(readReport(db, pane)).toMatchObject({
    tag: "Ok",
    value: { assignment: { key: "read", state: "running" }, launch: { id: "l1" }, reports: [] },
  });
  expect(readReport(db, { ...pane, socket: "/other.sock" })).toMatchObject({
    error: { reason: "worker_launch_not_found" },
  });
  expect(readReport(db, { ...key, checkout: "/moved" })).toMatchObject({
    error: { reason: "controller_mismatch" },
  });
  expect(readReport(db, { ...key, sourceId: "s2" })).toMatchObject({
    error: { reason: "source_not_found" },
  });
});

test("a refused rule writes nothing, and an accepted change applies in one transaction", () => {
  using db = fixture();
  running(db);
  expect(changeReport(db, pane, () => Err({ reason: "refused", detail: "No." }))).toMatchObject({
    error: { reason: "refused" },
  });
  expect(db.query("SELECT count(*) AS n FROM reports").get()).toEqual({ n: 0 });
  expect(
    changeReport(db, pane, () => Ok({ assignmentState: "reported", insert: row })),
  ).toMatchObject({ tag: "Ok" });
  expect(
    changeReport(db, key, (facts) => {
      expect(facts.reports).toMatchObject([{ number: 1, decision: null }]);
      return Ok({
        assignmentState: "completed",
        source: { state: "finished", endedAt: "later" },
        finishLaunch: "l1",
        update: { number: 1, decision: "accepted", cleanupState: "pending" },
      });
    }),
  ).toMatchObject({ tag: "Ok" });
  expect(db.query("SELECT state FROM assignments").get()).toEqual({ state: "completed" });
  expect(db.query("SELECT state, ended_at FROM sources").get()).toEqual({
    state: "finished",
    ended_at: "later",
  });
  expect(db.query("SELECT decision, cleanup_state FROM reports").get()).toEqual({
    decision: "accepted",
    cleanup_state: "pending",
  });
  // The finished launch ignores the pane close that acceptance causes.
  expect(db.query("SELECT state FROM launches").get()).toEqual({ state: "finished" });
  expect(
    observePane(db, {
      socket: "/herdr.sock",
      paneId: "w1:p1",
      workspaceId: "w1",
      observation: { exited: true },
    }),
  ).toMatchObject({ value: [] });
  expect(db.query("SELECT state FROM launches").get()).toEqual({ state: "finished" });
});

test("a returned report whose worker stopped permits a replacement launch", () => {
  using db = fixture();
  running(db);
  changeReport(db, pane, () => Ok({ assignmentState: "reported", insert: row }));
  observePane(db, {
    socket: "/herdr.sock",
    paneId: "w1:p1",
    workspaceId: "w1",
    observation: { exited: true },
  });
  const next = { ...launch, id: "l2", name: "report-app-1-read-2" };
  expect(reserveLaunch(db, "/one", "owner/one", next)).toMatchObject({
    error: { reason: "assignment_not_dispatchable" },
  });
  changeReport(db, key, () => Ok({ update: { number: 1, decision: "returned" } }));
  expect(reserveLaunch(db, "/one", "owner/one", next)).toMatchObject({
    tag: "Ok",
    value: { attempt: 2 },
  });
  expect(db.query("SELECT state FROM assignments").get()).toEqual({ state: "running" });
});
