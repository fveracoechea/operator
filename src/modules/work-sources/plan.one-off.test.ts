import { expect, test } from "bun:test";
import { configuredPlanSchema, oneOffPlan } from "./plan.ts";

test("one-off plans preserve supplied task fields in exactly one dependency-free assignment", () => {
  expect(
    oneOffPlan({
      kind: "prototype",
      instructions: "Build the queue.",
      trackerKey: "github:example/one#42",
      intent: "Keep ordering.",
      profile: "careful",
    }),
  ).toEqual({
    trackerKey: "github:example/one#42",
    assignments: [
      {
        key: "build-the-queue",
        trackerKey: "github:example/one#42",
        kind: "prototype",
        instructions: "Build the queue.",
        intent: "Keep ordering.",
        profile: "careful",
        dependencies: [],
      },
    ],
  });
});

test.each([
  { kind: "answer", completion: "report", resources: "pane" },
  { kind: "prototype", completion: "report", resources: "worktree" },
  { kind: "implementation", completion: "pr", resources: "worktree" },
])(
  "one-off $kind derives completion, resources and its worktree branch",
  ({ kind, completion, resources }) => {
    const plan = configuredPlanSchema({}, true).parse(
      oneOffPlan({ kind, instructions: "Build the queue." }),
    );
    expect(plan.trackerKey).toMatch(new RegExp(`^${kind}:[0-9a-f]{8}$`));
    expect(plan.assignments).toHaveLength(1);
    expect(plan.assignments[0]).toMatchObject({
      key: "build-the-queue",
      completion,
      resources,
      trackerKey: plan.trackerKey,
      dependencies: [],
    });
    if (resources === "worktree")
      expect(plan.assignments[0]).toHaveProperty("branch", "build-the-queue");
    else expect(plan.assignments[0]).not.toHaveProperty("branch");
  },
);

test("one-off keys have a fallback, six words, a length bound, and an explicit override", () => {
  for (const { instructions, key } of [
    { instructions: "?!", key: "question" },
    { instructions: "One two three four five six seven.", key: "one-two-three-four-five-six" },
    { instructions: "a".repeat(59) + " b", key: "a".repeat(59) },
    { instructions: "x".repeat(100), key: "x".repeat(60) },
  ])
    expect(oneOffPlan({ kind: "answer", instructions }).assignments[0]?.key).toBe(key);
  expect(
    oneOffPlan({ kind: "answer", instructions: "Question?", key: "chosen" }).assignments[0]?.key,
  ).toBe("chosen");
  const first = oneOffPlan({ kind: "answer", instructions: "Question?" });
  const second = oneOffPlan({ kind: "answer", instructions: "Question?" });
  expect(first.trackerKey).not.toBe(second.trackerKey);
});

test("ordinary plans do not silently derive a missing worktree branch", () => {
  const supplied = oneOffPlan({ kind: "prototype", instructions: "Build." });
  expect(configuredPlanSchema().safeParse(supplied).success).toBe(false);
  expect(configuredPlanSchema({}, true).parse(supplied).assignments[0]).toHaveProperty(
    "branch",
    "build",
  );
});
