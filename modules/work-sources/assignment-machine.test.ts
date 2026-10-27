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
test("only open or merged PRs and accepted reports satisfy dependencies", () => {
  for (const state of prStates)
    expect(dependencyBlockers([{ key: "parent", completion: "pr", state }]).length).toBe(
      state === "pr-open" || state === "merged" ? 0 : 1,
    );
  for (const state of reportStates)
    expect(dependencyBlockers([{ key: "parent", completion: "report", state }]).length).toBe(
      state === "completed" ? 0 : 1,
    );
  expect(
    dependencyBlockers([{ key: "research", completion: "report", state: "reported" }]),
  ).toEqual([
    { assignment: "research", completion: "report", state: "reported", required: "completed" },
  ]);
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
