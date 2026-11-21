import { expect, test } from "bun:test";
import { configuredPlanSchema, oneOffPlan } from "./plan.ts";
import { WorkerKinds } from "../worker-kinds/main.ts";

test.each([
  { completion: "pr", resources: "pane", needsBranch: true },
  { completion: "pr", resources: "worktree", needsBranch: true },
  { completion: "report", resources: "worktree", needsBranch: true },
  { completion: "report", resources: "pane", needsBranch: false },
])(
  "custom $completion/$resources one-offs derive only required branch metadata",
  ({ completion, resources, needsBranch }) => {
    const definitions = WorkerKinds.customSchema().parse({
      audit: {
        completion,
        resources,
        guide: "audit/SKILL.md",
        workPhases: [{ name: "inspect", goal: "Inspect the queue." }],
      },
    });
    const supplied = oneOffPlan({
      kind: "audit",
      instructions: "Inspect the queue.",
      trackerKey: "audit:one-off",
    });
    const plan = configuredPlanSchema(definitions, true).parse(supplied);
    expect(plan.assignments).toHaveLength(1);
    expect(plan.assignments[0]).toMatchObject({
      key: "inspect-the-queue",
      kind: "audit",
      completion,
      resources,
      dependencies: [],
    });
    if (needsBranch) {
      expect(plan.assignments[0]).toHaveProperty("branch", "inspect-the-queue");
      expect(configuredPlanSchema(definitions).safeParse(supplied).success).toBe(false);
      expect(
        configuredPlanSchema(definitions).parse({
          ...supplied,
          assignments: [{ ...supplied.assignments[0], branch: "task/inspect" }],
        }).assignments[0],
      ).toHaveProperty("branch", "task/inspect");
    } else {
      expect(plan.assignments[0]).not.toHaveProperty("branch");
      expect(configuredPlanSchema(definitions).parse(supplied)).toEqual(plan);
    }
  },
);

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
