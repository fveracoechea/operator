import { expect, test } from "bun:test";
import {
  decideAssignment,
  dependencyBlockers,
  type AssignmentState,
} from "./assignment-machine.ts";

const child: AssignmentState = { key: "child", completion: "commit", state: "ready" };
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
