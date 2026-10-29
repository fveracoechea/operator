import { afterAll, afterEach, expect, mock, spyOn, test } from "bun:test";
// Bun has no temporary-directory or recursive removal API.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Ok, OkAsync } from "unthrown";
import { DeviceState } from "../device-state/main.ts";
import { Environment } from "../environment/main.ts";
import { OperatorHome } from "../operator-home/main.ts";
import { Projects } from "../projects/main.ts";
import { WorkSources } from "./main.ts";
import { decodeSource } from "./snapshot.ts";
import {
  storedCleanup,
  storedLaunch,
  storedPullRequest,
  storedReport,
  storedSource,
} from "./source-fixture.ts";

const root = await mkdtemp(path.join(tmpdir(), "operator-source-next-"));
const paths = OperatorHome.resolve(Environment.parse({ HOME: root, NODE_ENV: "test" }));
const files = `${root}/.local/state/operator/projects/example/one/sources/one/assignments`;
const day = 24 * 60 * 60 * 1000;
afterEach(() => {
  mock.restore();
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

function stored(rows: ReturnType<typeof storedSource>[]) {
  spyOn(Projects, "current").mockReturnValue(
    OkAsync({
      reason: "project_resolved" as const,
      data: { repository: "example/one", checkout: root, registeredAt: "now" },
    }),
  );
  return spyOn(DeviceState, "readSources").mockReturnValue(Ok(rows));
}

function next() {
  return WorkSources.next({ paths, cwd: root });
}

const merged = {
  mergedHead: "abc",
  mergeCommit: "def",
  mergedAt: "2026-01-05T00:00:00.000Z",
};
const relay = { parent: { assignment: "m5", number: 3, branch: "task/m5" }, state: "stacked" };

const open = storedSource(
  [
    { key: "pr1", completion: "pr", state: "pr-open" },
    { key: "stop", completion: "pr", state: "pr-open" },
    { key: "rep", completion: "report", state: "reported" },
    { key: "ret", completion: "report", state: "reported" },
    { key: "acc", completion: "report", state: "completed" },
    { key: "dep", completion: "report", state: "ready", dependencies: ["acc"] },
    { key: "blk", completion: "report", state: "ready", dependencies: ["rep"] },
    { key: "fail", completion: "report", state: "running" },
    { key: "acf", completion: "report", state: "completed" },
    { key: "m1", completion: "pr", state: "merged" },
    { key: "m2", completion: "pr", state: "merged" },
    { key: "m3", completion: "pr", state: "merged" },
    { key: "m4", completion: "pr", state: "merged" },
    { key: "m5", completion: "pr", state: "merged" },
    { key: "m6", completion: "pr", state: "merged" },
  ],
  {
    launches: [
      storedLaunch("pr1", {
        resources: "worktree",
        branch: "task/pr1",
        worktreePath: "/worktrees/pr1",
        activity: "working",
        activityAt: "2026-01-02T01:00:00.000Z",
      }),
      storedLaunch("stop"),
      storedLaunch("rep", { state: "finished", endedAt: "2026-01-03T00:00:00.000Z" }),
      storedLaunch("ret"),
      storedLaunch("acc", { state: "finished" }),
      storedLaunch("fail", {
        state: "failed",
        failureReason: "host_failed",
        failureDetail: "The host stopped.",
      }),
      storedLaunch("acf", { state: "finished" }),
      ...["m1", "m2", "m3", "m4", "m5", "m6"].map((key) =>
        storedLaunch(key, { state: "finished" }),
      ),
    ],
    pullRequests: [
      storedPullRequest("pr1", {
        waitState: "waiting",
        waitAt: "2026-01-02T02:00:00.000Z",
        relay: JSON.stringify({ ...relay, blocker: null }),
      }),
      storedPullRequest("stop", { number: 8, waitState: "waiting", waitStopped: true }),
      ...["m1", "m2", "m3", "m4", "m5", "m6"].map((key) => storedPullRequest(key, merged)),
    ],
    reports: [
      storedReport("rep"),
      storedReport("ret", {
        decision: "returned",
        decidedAt: "2026-01-04T00:00:00.000Z",
        followUp: "Again.",
      }),
      storedReport("acc", {
        decision: "accepted",
        decidedAt: "2026-01-04T00:00:00.000Z",
        cleanupState: "done",
        cleanupDetail: "Closed.",
      }),
      storedReport("acf", {
        decision: "accepted",
        decidedAt: "2026-01-04T00:00:00.000Z",
        cleanupState: "failed",
        cleanupDetail: "The pane is busy.",
      }),
    ],
    cleanups: [
      storedCleanup("m1", { step: "pane", state: "pending", running: true }),
      storedCleanup("m2", {
        step: "worktree",
        state: "blocked",
        reason: "cleanup_resource_mismatch",
        detail: "Another checkout.",
      }),
      storedCleanup("m3", {
        step: "worktree",
        state: "blocked",
        reason: "cleanup_unlanded_work",
        detail: "Unpushed commits.",
      }),
      storedCleanup("m4", {
        step: "remote_branch",
        state: "failed",
        reason: "push_failed",
        detail: "The remote refused.",
      }),
      storedCleanup("m5"),
      storedCleanup("m6", { step: "pane", state: "pending" }),
    ],
  },
);

function finishedLaunch(key: string) {
  return {
    attempt: 1,
    state: "finished",
    name: `worker-${key}`,
    paneId: `w1:${key}`,
    worktreePath: null,
    branch: null,
    failure: null,
    observedActivity: null,
  };
}

type CleanupRow = {
  step: string;
  state: string;
  failure: { reason: string; detail: string } | null;
};

function mergedRow(key: string, action: string, reason: string, cleanup: CleanupRow) {
  return {
    assignment: key,
    action,
    reason,
    blockers: [],
    launch: finishedLaunch(key),
    pullRequest: {
      number: 7,
      url: "https://github.com/example/one/pull/7",
      branch: `task/${key}`,
      wait: "idle",
      waitAt: null,
      stack: null,
    },
    cleanup: { updatedAt: "2026-01-04T00:00:00.000Z", ...cleanup },
  };
}

test("next describes each open assignment with its recorded facts", async () => {
  stored([open]);
  const result = await next();
  expect(result.tag).toBe("Ok");
  const [source] = result.tag === "Ok" ? result.value.sources : [];
  expect(source?.id).toBe("one");
  expect(source?.state).toBe("open");
  expect<unknown>(source?.actions).toEqual([
    {
      assignment: "stop",
      action: "owner_attention",
      reason: "pr_wait_stopped",
      blockers: [],
      launch: { ...finishedLaunch("stop"), state: "running" },
      pullRequest: {
        number: 8,
        url: "https://github.com/example/one/pull/7",
        branch: "task/stop",
        wait: "stopped",
        waitAt: null,
        stack: null,
      },
    },
    {
      assignment: "rep",
      action: "review_report",
      reason: "report_submitted",
      blockers: [],
      launch: finishedLaunch("rep"),
      report: {
        number: 1,
        conclusion: "rep done.",
        unresolved: ["Gap of rep."],
        reference: "operator:example/one/sources/one/assignments/rep/reports/1",
        file: `${files}/rep/reports/1/report.md`,
        decision: null,
        followUp: null,
        cleanup: null,
      },
    },
    {
      assignment: "ret",
      action: "resume_worker",
      reason: "follow_up_returned",
      blockers: [],
      launch: { ...finishedLaunch("ret"), state: "running" },
      report: {
        number: 1,
        conclusion: "ret done.",
        unresolved: ["Gap of ret."],
        reference: "operator:example/one/sources/one/assignments/ret/reports/1",
        file: `${files}/ret/reports/1/report.md`,
        decision: "returned",
        followUp: `${files}/ret/follow-ups/1.md`,
        cleanup: null,
      },
    },
    {
      assignment: "dep",
      action: "ready_assignment",
      reason: "assignment_ready",
      blockers: [],
      dependencyReports: [
        {
          assignment: "acc",
          report: 1,
          conclusion: "acc done.",
          unresolved: ["Gap of acc."],
          reference: "operator:example/one/sources/one/assignments/acc/reports/1",
        },
      ],
    },
    {
      assignment: "fail",
      action: "replace_worker",
      reason: "launch_failed",
      blockers: [],
      launch: {
        ...finishedLaunch("fail"),
        state: "failed",
        failure: { reason: "host_failed", detail: "The host stopped." },
      },
    },
    {
      assignment: "acf",
      action: "retry_cleanup",
      reason: "cleanup_failed",
      blockers: [],
      launch: finishedLaunch("acf"),
      report: {
        number: 1,
        conclusion: "acf done.",
        unresolved: ["Gap of acf."],
        reference: "operator:example/one/sources/one/assignments/acf/reports/1",
        file: `${files}/acf/reports/1/report.md`,
        decision: "accepted",
        followUp: null,
        cleanup: { state: "failed", detail: "The pane is busy." },
      },
    },
    mergedRow("m2", "person_decision", "cleanup_resource_mismatch", {
      step: "worktree",
      state: "blocked",
      failure: { reason: "cleanup_resource_mismatch", detail: "Another checkout." },
    }),
    mergedRow("m3", "person_decision", "cleanup_unlanded_work", {
      step: "worktree",
      state: "blocked",
      failure: { reason: "cleanup_unlanded_work", detail: "Unpushed commits." },
    }),
    mergedRow("m4", "retry_cleanup", "cleanup_failed", {
      step: "remote_branch",
      state: "failed",
      failure: { reason: "push_failed", detail: "The remote refused." },
    }),
    mergedRow("m6", "retry_cleanup", "cleanup_stopped", {
      step: "pane",
      state: "pending",
      failure: null,
    }),
  ]);
  expect<unknown>(source?.waits).toEqual([
    {
      assignment: "pr1",
      action: "wait",
      reason: "pr_feedback_loop",
      blockers: [],
      launch: {
        ...finishedLaunch("pr1"),
        state: "running",
        worktreePath: "/worktrees/pr1",
        branch: "task/pr1",
        observedActivity: { state: "working", at: "2026-01-02T01:00:00.000Z" },
      },
      pullRequest: {
        number: 7,
        url: "https://github.com/example/one/pull/7",
        branch: "task/pr1",
        wait: "waiting",
        waitAt: "2026-01-02T02:00:00.000Z",
        stack: { ...relay, blocker: null },
      },
    },
    {
      assignment: "blk",
      action: "wait",
      reason: "dependencies_pending",
      blockers: [
        { assignment: "rep", completion: "report", state: "reported", required: "completed" },
      ],
    },
    mergedRow("m1", "wait", "cleanup_running", { step: "pane", state: "running", failure: null }),
  ]);
});

test("an ended source keeps its owed cleanup and offers prune only after retention", async () => {
  const ended = new Date(Date.now() - 15 * day).toISOString();
  const keys = ["acf", "m1", "m3", "m5"] as const;
  const owing = storedSource(
    [
      { key: "acf", completion: "report", state: "completed" },
      { key: "m1", completion: "pr", state: "merged" },
      { key: "m3", completion: "pr", state: "merged" },
      { key: "m5", completion: "pr", state: "merged" },
    ],
    {
      state: "finished",
      endedAt: ended,
      launches: keys.map((key) => storedLaunch(key, { state: "finished" })),
      pullRequests: ["m1", "m3", "m5"].map((key) => storedPullRequest(key, merged)),
      reports: [
        storedReport("acf", {
          decision: "accepted",
          decidedAt: ended,
          cleanupState: "failed",
          cleanupDetail: "The pane is busy.",
        }),
      ],
      cleanups: [
        storedCleanup("m1", { step: "pane", state: "pending", running: true }),
        storedCleanup("m3", {
          step: "worktree",
          state: "blocked",
          reason: "cleanup_unlanded_work",
          detail: "Unpushed commits.",
        }),
        storedCleanup("m5"),
      ],
    },
  );
  const prunableAt = new Date(Date.parse(ended) + 14 * day).toISOString();
  stored([owing]);
  const result = await next();
  const [source] = result.tag === "Ok" ? result.value.sources : [];
  expect(source?.state).toBe("finished");
  expect(source?.actions.map((row) => [row.action, row.reason])).toEqual([
    ["source_ended", "finished"],
    ["retry_cleanup", "cleanup_failed"],
    ["person_decision", "cleanup_unlanded_work"],
  ]);
  expect(source?.actions[0]).toEqual({
    action: "source_ended",
    reason: "finished",
    endedAt: ended,
    prunableAt,
  });
  expect(source?.waits).toMatchObject([{ assignment: "m1", reason: "cleanup_running" }]);
  mock.restore();

  const done = storedSource([{ key: "m5", completion: "pr", state: "merged" }], {
    state: "reset",
    endedAt: ended,
    launches: [storedLaunch("m5", { state: "finished" })],
    pullRequests: [storedPullRequest("m5", merged)],
    cleanups: [storedCleanup("m5")],
  });
  stored([done]);
  const pruned = await next();
  expect(pruned.tag === "Ok" ? pruned.value.sources[0] : null).toEqual({
    id: "one",
    state: "reset",
    actions: [
      { action: "source_ended", reason: "reset", endedAt: ended, prunableAt },
      { action: "prune_source", reason: "retention_elapsed" },
    ],
    waits: [],
  });
  mock.restore();

  const recent = new Date(Date.now() - day).toISOString();
  stored([{ ...done, source: { ...done.source, endedAt: recent } }]);
  const kept = await next();
  expect(kept.tag === "Ok" ? kept.value.sources[0]?.actions : null).toEqual([
    {
      action: "source_ended",
      reason: "reset",
      endedAt: recent,
      prunableAt: new Date(Date.parse(recent) + 14 * day).toISOString(),
    },
  ]);
});

test("show names each report with its durable reference, and a missing source is undefined", async () => {
  stored([open]);
  const shown = await WorkSources.show({ paths, cwd: root, sourceId: "one" });
  expect(shown.tag === "Ok" ? shown.value?.reports.map((row) => row.reference) : null).toEqual([
    "operator:example/one/sources/one/assignments/rep/reports/1",
    "operator:example/one/sources/one/assignments/ret/reports/1",
    "operator:example/one/sources/one/assignments/acc/reports/1",
    "operator:example/one/sources/one/assignments/acf/reports/1",
  ]);
  mock.restore();
  const read = stored([]);
  expect(await WorkSources.show({ paths, cwd: root, sourceId: "two" })).toMatchObject({
    tag: "Ok",
    value: undefined,
  });
  expect(read.mock.calls).toEqual([[paths, "example/one", "two"]]);
});

test("corrupt stored records are refused without repair", async () => {
  stored([{ ...open, source: { ...open.source, plan: "{broken" } }]);
  expect(await next()).toMatchObject({
    tag: "Err",
    error: {
      reason: "state_corrupt",
      detail: "Stored source records are invalid. They were not repaired.",
    },
  });
  mock.restore();
  stored([{ ...open, source: { ...open.source, trackerKey: "other" } }]);
  expect(await WorkSources.show({ paths, cwd: root, sourceId: "one" })).toMatchObject({
    tag: "Err",
    error: { reason: "state_corrupt" },
  });
});

test("the state after a write follows the assignment states", () => {
  expect(
    WorkSources.stateAfter([
      { key: "a", completion: "report", state: "completed" },
      { key: "b", completion: "pr", state: "merged" },
    ]),
  ).toBe("finished");
  expect(WorkSources.stateAfter([{ key: "a", completion: "report", state: "reported" }])).toBe(
    "open",
  );
  expect(() =>
    WorkSources.stateAfter([{ key: "a", completion: "report", state: "merged" }]),
  ).toThrow();
});

test("the report rule validates the assignment states it reads", () => {
  const facts = {
    command: "accept" as const,
    assignment: { key: "a", completion: "report", state: "reported" },
    launch: null,
    latest: { number: 1, decision: null, cleanupState: null },
    caller: { socket: null, paneId: null },
  };
  expect(
    WorkSources.decideReport({
      ...facts,
      assignments: [
        { key: "a", completion: "report", state: "reported" },
        { key: "b", completion: "report", state: "completed" },
      ],
    }),
  ).toMatchObject({ tag: "Ok", value: { sourceFinished: true, assignmentState: "completed" } });
  expect(() =>
    WorkSources.decideReport({
      ...facts,
      assignments: [{ key: "a", completion: "report", state: "merged" }],
    }),
  ).toThrow();
});

function prunable(rows: ReturnType<typeof storedSource>) {
  stored([rows]);
  return next().then((result) => {
    mock.restore();
    const actions = result.tag === "Ok" ? (result.value.sources[0]?.actions ?? []) : [];
    return actions.some((row) => row.action === "prune_source");
  });
}

test("an ended source with open cleanup or a live worker is not offered for prune", async () => {
  const ended = new Date(Date.now() - 15 * day).toISOString();
  function report(change: Parameters<typeof storedReport>[1], launch = {}) {
    return storedSource([{ key: "a", completion: "report", state: "completed" }], {
      state: "finished",
      endedAt: ended,
      launches: [storedLaunch("a", { state: "finished", ...launch })],
      reports: [storedReport("a", { decision: "accepted", decidedAt: ended, ...change })],
    });
  }
  expect(await prunable(report({ cleanupState: "done" }))).toBe(true);
  expect(await prunable(report({ cleanupState: null }))).toBe(true);
  expect(await prunable(report({ cleanupState: "pending" }))).toBe(false);
  expect(await prunable(report({ cleanupState: "failed" }))).toBe(false);
  expect(await prunable(report({ cleanupState: "done" }, { state: "running" }))).toBe(false);
  expect(await prunable(report({ cleanupState: "done" }, { state: "starting" }))).toBe(false);
  expect(
    await prunable(report({ cleanupState: "done" }, { state: "starting", abandoned: true })),
  ).toBe(true);
  const failedCleanup = storedSource([{ key: "m", completion: "pr", state: "merged" }], {
    state: "finished",
    endedAt: ended,
    launches: [storedLaunch("m", { state: "finished" })],
    pullRequests: [storedPullRequest("m", merged)],
    cleanups: [storedCleanup("m", { step: "pane", state: "failed", reason: "x", detail: "y" })],
  });
  expect(await prunable(failedCleanup)).toBe(false);
});

test("an abandoned start offers a replacement worker", async () => {
  stored([
    storedSource([{ key: "a", completion: "report", state: "running" }], {
      launches: [storedLaunch("a", { state: "starting", abandoned: true })],
    }),
  ]);
  const result = await next();
  expect(result.tag === "Ok" ? result.value.sources[0]?.actions[0] : null).toMatchObject({
    action: "replace_worker",
    reason: "launch_abandoned",
  });
});

test("an unplanned assignment carries no dependency reports", () => {
  const source = decodeSource(open);
  expect(WorkSources.dependencyReports(source, "missing")).toEqual([]);
  expect(WorkSources.dependencyReports(source, "dep").map((row) => row.assignment)).toEqual([
    "acc",
  ]);
});

test("a decoding defect stays a defect", async () => {
  const broken = Object.defineProperty({ ...open.source }, "plan", {
    get() {
      // oxlint-disable-next-line unthrown/no-throw -- Inject a defect while stored rows decode.
      throw new TypeError("decode defect");
    },
  });
  stored([{ ...open, source: broken }]);
  const result = await next();
  expect(result.tag).toBe("Defect");
  expect(result.tag === "Defect" ? String(result.cause) : null).toBe("TypeError: decode defect");
});
