import { expect, test } from "bun:test";
import { configuredPlanSchema, storedPlanSchema } from "./plan.ts";
import { WorkerKinds } from "../worker-kinds/main.ts";

const definitions = WorkerKinds.customSchema().parse({
  audit: {
    completion: "report",
    resources: "pane",
    profile: "careful",
    guide: "audit-guide/SKILL.md",
    workPhases: [{ name: "audit", goal: "Check evidence." }],
  },
});
const assignment = {
  key: "read",
  trackerKey: "APP-2",
  instructions: "Audit.",
  kind: "audit",
  dependencies: [],
};
const plan = { trackerKey: "APP-1", assignments: [assignment] };

test("configured plans resolve completion, resources and profile defaults from the custom kind", () => {
  expect(configuredPlanSchema(definitions).parse(plan).assignments).toEqual([
    { ...assignment, completion: "report", resources: "pane", profile: "careful" },
  ]);
  expect(
    configuredPlanSchema(definitions).parse({
      ...plan,
      assignments: [
        { ...assignment, resources: "worktree", branch: "task/audit", profile: "fast" },
      ],
    }).assignments,
  ).toEqual([
    {
      ...assignment,
      completion: "report",
      resources: "worktree",
      branch: "task/audit",
      profile: "fast",
    },
  ]);
});

test("new plans reject unknown kinds and completion overrides but stored plans retain custom names", () => {
  expect(configuredPlanSchema().safeParse(plan).success).toBe(false);
  expect(
    configuredPlanSchema(definitions).safeParse({
      ...plan,
      assignments: [{ ...assignment, completion: "pr" }],
    }).success,
  ).toBe(false);
  expect(
    configuredPlanSchema(definitions).safeParse({
      ...plan,
      assignments: [{ ...assignment, resources: "worktree" }],
    }).success,
  ).toBe(false);
  expect(
    storedPlanSchema.parse({
      ...plan,
      assignments: [{ ...assignment, completion: "report", resources: "pane" }],
    }).assignments[0],
  ).toMatchObject({ kind: "audit", completion: "report" });
});
