import { expect, test } from "bun:test";
import { planSchema } from "./plan.ts";

const report = {
  key: "read",
  trackerKey: "APP-2",
  instructions: "Read the code.",
  completion: "report",
  resources: "pane",
  dependencies: [],
};
const pr = {
  ...report,
  key: "fix",
  completion: "pr",
  resources: "worktree",
  branch: "task/fix",
};

function messages(plan: Record<string, unknown>) {
  const result = planSchema.safeParse(plan);
  return result.success ? [] : result.error.issues.map((issue) => [issue.code, issue.message]);
}

function assignments(...rows: Record<string, unknown>[]) {
  return { trackerKey: "APP-1", assignments: rows };
}

test("a PR assignment needs a worktree and its branch", () => {
  expect(planSchema.parse(assignments(pr)).assignments).toEqual([
    {
      key: "fix",
      trackerKey: "APP-2",
      instructions: "Read the code.",
      completion: "pr",
      resources: "worktree",
      branch: "task/fix",
      dependencies: [],
    },
  ]);
  expect(planSchema.safeParse(assignments({ ...pr, resources: "pane" })).success).toBe(false);
  expect(planSchema.safeParse(assignments({ ...pr, completion: "merge" })).success).toBe(false);
});

test("keys, instructions, and profiles refuse surrounding spaces and unknown shapes", () => {
  expect(messages(assignments({ ...report, key: " read" }))).toEqual([
    ["custom", "Use a nonempty key without surrounding spaces."],
  ]);
  expect(messages(assignments({ ...report, instructions: "   " })).length).toBe(1);
  expect(
    planSchema.parse(assignments({ ...report, instructions: " Read. " })).assignments[0]
      ?.instructions,
  ).toBe("Read.");
  expect(messages(assignments({ ...pr, branch: "a~b" }))).toEqual([
    ["custom", "Use a valid Git branch name."],
  ]);
  // Exclamation marks are printable, so Git accepts them.
  expect(planSchema.parse(assignments({ ...pr, branch: "fix!" })).assignments[0]).toMatchObject({
    branch: "fix!",
  });
  for (const profile of ["careful", "c", "deep-2"])
    expect(planSchema.parse(assignments({ ...report, profile })).assignments[0]).toMatchObject({
      profile,
    });
  for (const profile of ["1abc", "abC", "Careful", "-x", "a b"])
    expect(planSchema.safeParse(assignments({ ...report, profile })).success).toBe(false);
});

test("dependency refusals name the assignment and the dependency", () => {
  expect(messages(assignments(report, report))).toEqual([
    ["custom", "Assignment keys must be unique."],
  ]);
  expect(messages(assignments(report, { ...pr, dependencies: ["read", "read"] }))).toEqual([
    ["custom", "Duplicate dependency for fix."],
  ]);
  expect(messages(assignments(report, { ...pr, dependencies: ["missing"] }))).toEqual([
    ["custom", "Invalid dependency missing for fix."],
  ]);
  expect(messages(assignments({ ...report, dependencies: ["read"] }))).toEqual([
    ["custom", "Invalid dependency read for read."],
    ["custom", "Dependencies must form an acyclic plan within this source."],
  ]);
  expect(
    messages(
      assignments(
        report,
        { ...pr, dependencies: ["last"] },
        { ...report, key: "last", dependencies: ["fix", "read"] },
      ),
    ),
  ).toEqual([["custom", "Dependencies must form an acyclic plan within this source."]]);
  // A long chain settles one assignment per round.
  expect(
    messages(
      assignments(
        { ...report, key: "d", dependencies: ["c"] },
        { ...report, key: "c", dependencies: ["b"] },
        { ...report, key: "b", dependencies: ["a"] },
        { ...report, key: "a" },
      ),
    ),
  ).toEqual([]);
});
