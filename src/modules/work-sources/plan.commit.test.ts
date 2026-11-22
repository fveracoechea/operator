import { expect, test } from "bun:test";
import { planSchema } from "./plan.ts";

const assignment = {
  key: "411",
  trackerKey: "#411",
  instructions: "Implement the ticket.",
  kind: "commit-implementation",
  branch: "ticket/411",
  dependencies: [],
  delivery: { checks: [["bun", "run", "quality"]] },
};

test("source-wide review opt-outs cannot weaken commit review", () => {
  const parsed = planSchema.safeParse({
    trackerKey: "#411",
    internalReview: false,
    assignments: [assignment],
  });
  expect(parsed.success).toBe(false);
  if (parsed.success) return expect.unreachable();
  expect(parsed.error.issues).toEqual([
    {
      code: "custom",
      message: "Commit delivery always requires fresh review.",
      path: [],
    },
  ]);
});

test("new work explicitly selects commit completion with required checks and isolated resources", () => {
  expect(
    planSchema.parse({ trackerKey: "#411", assignments: [assignment] }).assignments[0],
  ).toEqual({ ...assignment, completion: "commit", resources: "worktree", profile: undefined });
});

test.each([
  { resources: "pane" },
  { adopt: 42 },
  { completion: "pr" },
  { internalReview: false },
  { delivery: { checks: [] } },
  { delivery: undefined },
  { kind: "implementation" },
])("commit delivery refuses incompatible policy %j without changing PR defaults", (change) => {
  expect(
    planSchema.safeParse({ trackerKey: "#411", assignments: [{ ...assignment, ...change }] })
      .success,
  ).toBe(false);
});
