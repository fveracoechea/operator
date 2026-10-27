import { expect, test } from "bun:test";
import {
  assignmentStateSchema,
  decideAssignment,
  dependencyBlockers,
  type AssignmentState,
} from "./assignment-machine.ts";

const prStates = ["ready", "running", "pr-open", "merged", "abandoned"] as const;
const reportStates = ["ready", "running", "reported", "completed", "abandoned"] as const;
test("PR and report states remain closed and completion-specific", () => {
  expect(
    assignmentStateSchema.safeParse({ key: "one", completion: "pr", state: "reported" }).success,
  ).toBe(false);
  expect(
    assignmentStateSchema.safeParse({ key: "one", completion: "report", state: "pr-open" }).success,
  ).toBe(false);
  expect(
    assignmentStateSchema.safeParse({ key: "one", completion: "report", state: "unknown" }).success,
  ).toBe(false);
});
const child: AssignmentState = { key: "child", completion: "pr", state: "ready" };
test("only open or merged PRs and accepted reports satisfy dependencies", () => {
  for (const state of prStates)
    expect(dependencyBlockers(child, [{ key: "parent", completion: "pr", state }]).length).toBe(
      state === "pr-open" || state === "merged" ? 0 : 1,
    );
  for (const state of reportStates)
    expect(dependencyBlockers(child, [{ key: "parent", completion: "report", state }]).length).toBe(
      state === "completed" ? 0 : 1,
    );
  expect(
    dependencyBlockers(child, [{ key: "research", completion: "report", state: "reported" }]),
  ).toEqual([
    { assignment: "research", completion: "report", state: "reported", required: "completed" },
  ]);
});
test("a PR stacks on one open parent, so several open parents wait for all but one to merge", () => {
  function open(key: string): AssignmentState {
    return { key, completion: "pr", state: "pr-open" };
  }
  const merged: AssignmentState = { key: "done", completion: "pr", state: "merged" };
  expect(dependencyBlockers(child, [open("a"), merged])).toEqual([]);
  expect(dependencyBlockers(child, [open("a"), open("b")])).toEqual([
    { assignment: "a", completion: "pr", state: "pr-open", required: "merged" },
    { assignment: "b", completion: "pr", state: "pr-open", required: "merged" },
  ]);
  // A report reads no branch, so it can start on several open parents.
  const report: AssignmentState = { key: "read", completion: "report", state: "ready" };
  expect(dependencyBlockers(report, [open("a"), open("b")])).toEqual([]);
  expect(
    decideAssignment({ assignment: child, dependencies: [open("a"), open("b")] }),
  ).toMatchObject({ action: "wait", reason: "dependencies_pending" });
});
test("a blocked relay needs owner attention, and a stopped owner is still replaced first", () => {
  const owner: AssignmentState = { key: "child", completion: "pr", state: "pr-open" };
  expect(
    decideAssignment({
      assignment: owner,
      dependencies: [],
      relay: "blocked",
      launch: "running",
      pullRequest: "reported",
    }),
  ).toMatchObject({ action: "owner_attention", reason: "pr_relay_blocked" });
  expect(
    decideAssignment({
      assignment: owner,
      dependencies: [],
      relay: "blocked",
      launch: "interrupted",
    }),
  ).toMatchObject({ action: "replace_worker", reason: "worker_interrupted" });
  for (const relay of ["stacked", "relayed"] as const)
    expect(
      decideAssignment({
        assignment: owner,
        dependencies: [],
        relay,
        launch: "running",
        pullRequest: "waiting",
      }),
    ).toMatchObject({ action: "wait", reason: "pr_feedback_loop" });
});
test("the ordered assignment table exposes only ready work, preserving active and ended states", () => {
  const states: AssignmentState[] = [
    ...prStates.map((state) => ({ key: "one", completion: "pr" as const, state })),
    ...reportStates.map((state) => ({ key: "one", completion: "report" as const, state })),
  ];
  for (const assignment of states) {
    const before = structuredClone(assignment);
    const decision = decideAssignment({ assignment, dependencies: [] });
    expect(decision.action).toBe(
      assignment.state === "ready"
        ? "ready_assignment"
        : ["merged", "completed", "abandoned"].includes(assignment.state)
          ? "ended"
          : "wait",
    );
    expect(assignment).toEqual(before);
    expect(decideAssignment({ assignment, dependencies: [] })).toEqual(decision);
  }
  expect(
    decideAssignment({
      assignment: { key: "child", completion: "pr", state: "ready" },
      dependencies: [{ key: "parent", completion: "report", state: "reported" }],
    }),
  ).toMatchObject({
    action: "wait",
    reason: "dependencies_pending",
    blockers: [{ assignment: "parent" }],
  });
});

test("a failed or interrupted launch offers a replacement, and activity is never an input", () => {
  const running: AssignmentState = { key: "one", completion: "report", state: "running" };
  expect(decideAssignment({ assignment: running, dependencies: [], launch: "failed" })).toEqual({
    action: "replace_worker",
    reason: "launch_failed",
    blockers: [],
  });
  expect(
    decideAssignment({ assignment: running, dependencies: [], launch: "interrupted" }),
  ).toMatchObject({ action: "replace_worker", reason: "worker_interrupted" });
  expect(
    decideAssignment({ assignment: running, dependencies: [], launch: "starting" }),
  ).toMatchObject({ action: "wait", reason: "launch_starting" });
  expect(
    decideAssignment({ assignment: running, dependencies: [], launch: "abandoned" }),
  ).toMatchObject({ action: "replace_worker", reason: "launch_abandoned" });
  expect(
    decideAssignment({ assignment: running, dependencies: [], launch: "running" }),
  ).toMatchObject({ action: "wait", reason: "assignment_active" });
  const reported: AssignmentState = { key: "one", completion: "report", state: "reported" };
  expect(
    decideAssignment({ assignment: reported, dependencies: [], launch: "failed" }),
  ).toMatchObject({ action: "wait", reason: "assignment_active" });
});

test("a PR open owner stays in its feedback loop until a timeout or a closed PR needs attention", () => {
  const open: AssignmentState = { key: "one", completion: "pr", state: "pr-open" };
  for (const pullRequest of ["idle", "waiting", "reported"] as const)
    expect(
      decideAssignment({ assignment: open, dependencies: [], launch: "running", pullRequest }),
    ).toEqual({ action: "wait", reason: "pr_feedback_loop", blockers: [] });
  expect(
    decideAssignment({
      assignment: open,
      dependencies: [],
      launch: "running",
      pullRequest: "timed_out",
    }),
  ).toEqual({ action: "owner_attention", reason: "pr_wait_timed_out", blockers: [] });
  expect(
    decideAssignment({
      assignment: open,
      dependencies: [],
      launch: "running",
      pullRequest: "not_open",
    }),
  ).toEqual({ action: "owner_attention", reason: "pr_not_open", blockers: [] });
  // A stopped owner is replaced before its last wait result matters.
  for (const [launch, reason] of [
    ["interrupted", "worker_interrupted"],
    ["failed", "launch_failed"],
    ["abandoned", "launch_abandoned"],
  ] as const)
    expect(
      decideAssignment({ assignment: open, dependencies: [], launch, pullRequest: "timed_out" }),
    ).toEqual({ action: "replace_worker", reason, blockers: [] });
  // Wait facts never act on an assignment that is not PR open.
  const running: AssignmentState = { key: "one", completion: "pr", state: "running" };
  expect(
    decideAssignment({
      assignment: running,
      dependencies: [],
      launch: "running",
      pullRequest: "timed_out",
    }),
  ).toMatchObject({ action: "wait", reason: "assignment_active" });
  expect(
    decideAssignment({
      assignment: { key: "one", completion: "pr", state: "merged" },
      dependencies: [],
      launch: "interrupted",
      pullRequest: "timed_out",
    }),
  ).toMatchObject({ action: "ended" });
});

test("a stopped wait or an idle PR owner needs attention, but a running wait does not", () => {
  const open: AssignmentState = { key: "one", completion: "pr", state: "pr-open" };
  const facts = { assignment: open, dependencies: [], launch: "running" as const };
  expect(decideAssignment({ ...facts, pullRequest: "stopped" })).toEqual({
    action: "owner_attention",
    reason: "pr_wait_stopped",
    blockers: [],
  });
  for (const pullRequest of ["idle", "reported"] as const)
    for (const activity of ["idle", "done"])
      expect(decideAssignment({ ...facts, pullRequest, activity })).toEqual({
        action: "owner_attention",
        reason: "pr_owner_idle",
        blockers: [],
      });
  for (const activity of ["working", "blocked", null, undefined])
    expect(decideAssignment({ ...facts, pullRequest: "reported", activity })).toMatchObject({
      reason: "pr_feedback_loop",
    });
  expect(decideAssignment({ ...facts, pullRequest: "waiting", activity: "idle" })).toMatchObject({
    reason: "pr_feedback_loop",
  });
  // Before a PR exists, an idle worker gets worker attention, not owner attention.
  expect(
    decideAssignment({
      assignment: { key: "one", completion: "pr", state: "running" },
      dependencies: [],
      launch: "running",
      activity: "idle",
    }),
  ).toEqual({ action: "worker_attention", reason: "worker_idle", blockers: [] });
});

test("a running worker that stops with no PR or report needs attention", () => {
  for (const assignment of [
    { key: "one", completion: "pr", state: "running" },
    { key: "one", completion: "report", state: "running" },
  ] satisfies AssignmentState[]) {
    const facts = { assignment, dependencies: [], launch: "running" as const };
    for (const activity of ["idle", "done"])
      expect(decideAssignment({ ...facts, activity })).toEqual({
        action: "worker_attention",
        reason: "worker_idle",
        blockers: [],
      });
    for (const activity of ["working", "blocked", "unknown", null, undefined])
      expect(decideAssignment({ ...facts, activity })).toMatchObject({
        reason: "assignment_active",
      });
    // A stopped launch needs a replacement, not a question to its worker.
    expect(decideAssignment({ ...facts, launch: "interrupted", activity: "idle" })).toMatchObject({
      action: "replace_worker",
    });
    expect(decideAssignment({ ...facts, launch: "starting", activity: "idle" })).toMatchObject({
      reason: "launch_starting",
    });
  }
  // A submitted report waits for the SuperAgent, and returned work for its worker.
  const reported: AssignmentState = { key: "one", completion: "report", state: "reported" };
  expect(
    decideAssignment({
      assignment: reported,
      dependencies: [],
      launch: "running",
      activity: "done",
      report: { decision: null, cleanup: null },
    }),
  ).toMatchObject({ reason: "report_submitted" });
  expect(
    decideAssignment({
      assignment: reported,
      dependencies: [],
      launch: "running",
      activity: "idle",
      report: { decision: "returned", cleanup: null },
    }),
  ).toMatchObject({ reason: "follow_up_returned" });
});

test("reports await review, returned work needs its worker, and unfinished cleanup stays visible", () => {
  const reported: AssignmentState = { key: "one", completion: "report", state: "reported" };
  const submitted = { decision: null, cleanup: null };
  const returned = { decision: "returned" as const, cleanup: null };
  // A submitted report waits for the SuperAgent, also when its worker pane ended.
  for (const launch of ["running", "interrupted", "failed"] as const)
    expect(
      decideAssignment({ assignment: reported, dependencies: [], launch, report: submitted }),
    ).toMatchObject({ action: "review_report", reason: "report_submitted" });
  expect(
    decideAssignment({
      assignment: reported,
      dependencies: [],
      launch: "running",
      report: returned,
    }),
  ).toMatchObject({ action: "resume_worker", reason: "follow_up_returned" });
  for (const [launch, reason] of [
    ["interrupted", "worker_interrupted"],
    ["failed", "launch_failed"],
    ["abandoned", "launch_abandoned"],
  ] as const)
    expect(
      decideAssignment({ assignment: reported, dependencies: [], launch, report: returned }),
    ).toMatchObject({ action: "replace_worker", reason });
  const completed: AssignmentState = { key: "one", completion: "report", state: "completed" };
  for (const [cleanup, reason] of [
    ["failed", "cleanup_failed"],
    ["pending", "cleanup_unfinished"],
  ] as const)
    expect(
      decideAssignment({
        assignment: completed,
        dependencies: [],
        launch: "finished",
        report: { decision: "accepted", cleanup },
      }),
    ).toMatchObject({ action: "retry_cleanup", reason });
  expect(
    decideAssignment({
      assignment: completed,
      dependencies: [],
      report: { decision: "accepted", cleanup: "done" },
    }),
  ).toMatchObject({ action: "ended" });
});

test("a merged assignment shows its open cleanup until every resource is disposed", () => {
  const merged: AssignmentState = { key: "one", completion: "pr", state: "merged" };
  // The pane closed during cleanup, so the launch reads interrupted. It needs no replacement.
  const facts = { assignment: merged, dependencies: [], launch: "interrupted" as const };
  const cases = [
    ["running", "wait", "cleanup_running"],
    ["unlanded_work", "person_decision", "cleanup_unlanded_work"],
    ["resource_mismatch", "person_decision", "cleanup_resource_mismatch"],
    ["failed", "retry_cleanup", "cleanup_failed"],
    ["pending", "retry_cleanup", "cleanup_stopped"],
    ["done", "ended", "assignment_ended"],
    [undefined, "ended", "assignment_ended"],
  ] as const;
  for (const [cleanup, action, reason] of cases)
    expect(decideAssignment({ ...facts, cleanup })).toEqual({ action, reason, blockers: [] });
});
