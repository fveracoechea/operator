import { expect, test } from "bun:test";
import {
  assignmentStateSchema,
  decideAssignment,
  dependencyBlockers,
  type AssignmentState,
} from "./assignment-machine.ts";

test("every PR and report state parses with its completion", () => {
  for (const state of ["ready", "running", "pr-open", "merged", "abandoned"])
    expect<unknown>(assignmentStateSchema.parse({ key: "a", completion: "pr", state })).toEqual({
      key: "a",
      completion: "pr",
      state,
    });
  for (const state of ["ready", "running", "reported", "completed", "abandoned"])
    expect<unknown>(assignmentStateSchema.parse({ key: "a", completion: "report", state })).toEqual(
      {
        key: "a",
        completion: "report",
        state,
      },
    );
});

test("an unopened PR dependency requires an open or merged PR", () => {
  expect<unknown>(
    dependencyBlockers({ key: "child", completion: "report", state: "ready" }, [
      { key: "parent", completion: "pr", state: "running" },
    ]),
  ).toEqual([
    { assignment: "parent", completion: "pr", state: "running", required: "pr-open-or-merged" },
  ]);
});

function decision(action: string, reason: string) {
  return { action, reason, blockers: [] };
}

function decide(
  assignment: AssignmentState,
  facts: Omit<Parameters<typeof decideAssignment>[0], "assignment" | "dependencies"> = {},
) {
  return decideAssignment({ assignment, dependencies: [], ...facts });
}

function reportRow(state: Extract<AssignmentState, { completion: "report" }>["state"]) {
  return { key: "a", completion: "report" as const, state };
}
function prRow(state: Extract<AssignmentState, { completion: "pr" }>["state"]) {
  return { key: "a", completion: "pr" as const, state };
}

test("each rule matches only its own assignment state", () => {
  // Only reported work with a returned report needs its worker.
  expect<unknown>(
    decide(reportRow("ready"), {
      report: { decision: "returned", cleanup: null },
      launch: "failed",
    }),
  ).toEqual(decision("ready_assignment", "assignment_ready"));
  // Unfinished cleanup is retried only for completed work.
  expect<unknown>(
    decide(reportRow("reported"), { report: { decision: "accepted", cleanup: "failed" } }),
  ).toEqual(decision("wait", "assignment_active"));
  expect<unknown>(
    decide(reportRow("completed"), { report: { decision: "accepted", cleanup: "pending" } }),
  ).toEqual(decision("retry_cleanup", "cleanup_unfinished"));
  expect<unknown>(
    decide(reportRow("completed"), { report: { decision: "accepted", cleanup: "failed" } }),
  ).toEqual(decision("retry_cleanup", "cleanup_failed"));
  // Only reported work waits for review.
  expect<unknown>(
    decide(reportRow("running"), { report: { decision: null, cleanup: null } }),
  ).toEqual(decision("wait", "assignment_active"));
  expect<unknown>(
    decide(reportRow("reported"), { report: { decision: null, cleanup: null } }),
  ).toEqual(decision("review_report", "report_submitted"));
});

test("only reported work with a returned report and a running worker resumes", () => {
  const returned = { decision: "returned" as const, cleanup: null };
  expect<unknown>(decide(reportRow("reported"), { report: returned, launch: "running" })).toEqual(
    decision("resume_worker", "follow_up_returned"),
  );
  expect<unknown>(decide(reportRow("running"), { report: returned, launch: "running" })).toEqual(
    decision("wait", "assignment_active"),
  );
  expect<unknown>(
    decide(reportRow("reported"), {
      report: { decision: "accepted", cleanup: null },
      launch: "running",
    }),
  ).toEqual(decision("wait", "assignment_active"));
  expect<unknown>(decide(reportRow("reported"), { report: returned, launch: "finished" })).toEqual(
    decision("wait", "assignment_active"),
  );
  expect<unknown>(decide(reportRow("running"), { launch: "starting" })).toEqual(
    decision("wait", "launch_starting"),
  );
});

test("PR attention rules apply only to open PR work", () => {
  expect<unknown>(decide(prRow("running"), { relay: "blocked" })).toEqual(
    decision("wait", "assignment_active"),
  );
  expect<unknown>(decide(prRow("pr-open"), { relay: "blocked" })).toEqual(
    decision("owner_attention", "pr_relay_blocked"),
  );
  expect<unknown>(decide(prRow("running"), { pullRequest: "not_open" })).toEqual(
    decision("wait", "assignment_active"),
  );
  expect<unknown>(decide(prRow("running"), { pullRequest: "stopped" })).toEqual(
    decision("wait", "assignment_active"),
  );
});

test("an idle host needs attention only for running work with a running launch", () => {
  expect<unknown>(decide(reportRow("running"), { launch: "running", activity: "idle" })).toEqual(
    decision("worker_attention", "worker_idle"),
  );
  expect<unknown>(
    decide(reportRow("reported"), {
      report: { decision: "accepted", cleanup: null },
      launch: "running",
      activity: "done",
    }),
  ).toEqual(decision("wait", "assignment_active"));
  expect<unknown>(decide(reportRow("running"), { launch: "finished", activity: "idle" })).toEqual(
    decision("wait", "assignment_active"),
  );
});
