import { expect, test } from "bun:test";
import {
  assignmentStateSchema,
  decideAssignment,
  dependencyBlockers,
  type AssignmentState,
} from "./assignment-machine.ts";

const child: AssignmentState = { key: "child", completion: "commit", state: "ready" };
test("commit states accept only ready, running, completed and abandoned", () => {
  for (const state of ["ready", "running", "completed", "abandoned"] as const)
    expect(assignmentStateSchema.parse({ key: "ticket", completion: "commit", state })).toEqual({
      key: "ticket",
      completion: "commit",
      state,
    });
  for (const state of ["pr-open", "merged", "reported", "", "unknown"])
    expect(
      assignmentStateSchema.safeParse({ key: "ticket", completion: "commit", state }).success,
    ).toBe(false);
});

test("only running commit assignments expose the exhausted-review person decision", () => {
  const commitReview = {
    rounds: [{ findings: [{ severity: "blocker" }] }, { findings: [{ severity: "blocker" }] }],
    dispositions: [
      { round: 1, finding: 1, disposition: "applied" },
      { round: 2, finding: 1, disposition: "applied" },
    ],
  };
  const assignments: AssignmentState[] = [
    { key: "one", completion: "pr", state: "running" },
    { key: "one", completion: "report", state: "running" },
    { key: "one", completion: "commit", state: "ready" },
    { key: "one", completion: "commit", state: "completed" },
    { key: "one", completion: "commit", state: "abandoned" },
  ];
  for (const assignment of assignments) {
    const expected: ReturnType<typeof decideAssignment> =
      assignment.state === "ready"
        ? { action: "ready_assignment", reason: "assignment_ready", blockers: [] }
        : assignment.state === "running"
          ? { action: "wait", reason: "assignment_active", blockers: [] }
          : { action: "ended", reason: "assignment_ended", blockers: [] };
    expect(decideAssignment({ assignment, dependencies: [], commitReview })).toEqual(expected);
  }
  expect(
    decideAssignment({
      assignment: { ...child, state: "running" },
      dependencies: [],
      commitReview,
    }),
  ).toEqual({
    action: "person_decision",
    reason: "commit_review_limit",
    blockers: [],
  });
});

test("retained history stops only completed commit assignments and always names empty blockers", () => {
  const assignments: AssignmentState[] = [
    { ...child, state: "completed" },
    { ...child, state: "running" },
    child,
    { key: "report", completion: "report", state: "completed" },
    { key: "pr", completion: "pr", state: "merged" },
  ];
  for (const assignment of assignments) {
    for (const commitHistoryRetained of [undefined, false, true]) {
      const expected: ReturnType<typeof decideAssignment> =
        assignment.completion === "commit" &&
        assignment.state === "completed" &&
        commitHistoryRetained === true
          ? { action: "person_decision", reason: "cleanup_unlanded_work", blockers: [] }
          : assignment.state === "ready"
            ? { action: "ready_assignment", reason: "assignment_ready", blockers: [] }
            : assignment.state === "running"
              ? { action: "wait", reason: "assignment_active", blockers: [] }
              : { action: "ended", reason: "assignment_ended", blockers: [] };
      expect(decideAssignment({ assignment, dependencies: [], commitHistoryRetained })).toEqual(
        expected,
      );
    }
  }
});

test("commit handoffs apply only to running work without a pending stack", () => {
  const assignments: AssignmentState[] = [
    { ...child, state: "running" },
    child,
    { key: "pr", completion: "pr", state: "running" },
    { key: "report", completion: "report", state: "running" },
  ];
  for (const assignment of assignments) {
    for (const handoff of ["running", "failed", "stopped"] as const) {
      for (const stack of [undefined, "planned", "blocked"] as const) {
        let expected: ReturnType<typeof decideAssignment> =
          assignment.state === "ready"
            ? { action: "ready_assignment", reason: "assignment_ready", blockers: [] }
            : { action: "wait", reason: "assignment_active", blockers: [] };
        if (stack !== undefined)
          expected =
            stack === "blocked"
              ? { action: "worker_attention", reason: "stack_blocked", blockers: [] }
              : { action: "wait", reason: "stack_pending", blockers: [] };
        else if (assignment.completion === "commit" && assignment.state === "running")
          expected =
            handoff === "running"
              ? { action: "wait", reason: "kind_handoff", blockers: [] }
              : { action: "replace_worker", reason: "handoff_failed", blockers: [] };
        expect(decideAssignment({ assignment, dependencies: [], handoff, stack })).toEqual(
          expected,
        );
      }
    }
  }
});

test("commit delivery waits for merged PR dependencies, while PR work may stack on an open PR", () => {
  const parent: AssignmentState = { key: "parent", completion: "pr", state: "pr-open" };
  expect(dependencyBlockers(child, [parent])).toEqual([
    { assignment: "parent", completion: "pr", state: "pr-open", required: "merged" },
  ]);
  expect(dependencyBlockers({ key: "child", state: "ready", completion: "pr" }, [parent])).toEqual(
    [],
  );
  expect(dependencyBlockers(child, [{ ...parent, state: "merged" }])).toEqual([]);
  expect(
    dependencyBlockers(child, [{ key: "parent", completion: "commit", state: "running" }]),
  ).toEqual([
    { assignment: "parent", completion: "commit", state: "running", required: "completed" },
  ]);
});

test("commit handoffs and retained squash history have explicit next actions without PR facts", () => {
  const assignment: AssignmentState = { ...child, state: "running" };
  expect(decideAssignment({ assignment, dependencies: [], handoff: "running" })).toMatchObject({
    action: "wait",
    reason: "kind_handoff",
  });
  expect(decideAssignment({ assignment, dependencies: [], handoff: "failed" })).toMatchObject({
    action: "replace_worker",
    reason: "handoff_failed",
  });
  expect(
    decideAssignment({
      assignment: { ...assignment, state: "completed" },
      dependencies: [],
      commitHistoryRetained: true,
    }),
  ).toMatchObject({ action: "person_decision", reason: "cleanup_unlanded_work" });
});

test("exhausted review requires a person only for applied final blockers", () => {
  const assignment: AssignmentState = { key: "ticket", completion: "commit", state: "running" };
  const rounds = [{ findings: [{ severity: "blocker" }] }, { findings: [{ severity: "blocker" }] }];
  expect(
    decideAssignment({
      assignment,
      dependencies: [],
      commitReview: {
        rounds,
        dispositions: [
          { round: 1, finding: 1, disposition: "applied" },
          { round: 2, finding: 1, disposition: "applied" },
        ],
      },
    }),
  ).toMatchObject({ action: "person_decision", reason: "commit_review_limit" });
  expect(
    decideAssignment({
      assignment,
      dependencies: [],
      commitReview: {
        rounds,
        dispositions: [
          { round: 1, finding: 1, disposition: "applied" },
          { round: 2, finding: 1, disposition: "declined" },
        ],
      },
    }),
  ).toMatchObject({ action: "wait", reason: "assignment_active" });
});
