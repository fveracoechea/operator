import { expect, test } from "bun:test";
import { planSchema } from "./plan.ts";

const report = {
  key: "read",
  trackerKey: "LINEAR-24",
  instructions: "Read the code.",
  completion: "report",
  resources: "pane",
  dependencies: [],
};
test("accepts tracker-neutral keys, arbitrary task instructions, and pane or worktree reports", () => {
  expect(
    planSchema.parse({
      trackerKey: "jira:APP-1",
      assignments: [
        report,
        { ...report, key: "write", resources: "worktree", branch: "reports/24" },
      ],
    }).assignments,
  ).toHaveLength(2);
  expect(planSchema.parse({ trackerKey: "APP-1", assignments: [] }).assignments).toEqual([]);
});
test.each([
  "",
  "-flag",
  "..",
  "bad..name",
  "/start",
  "end/",
  "end.",
  "one//two",
  ".hidden",
  "one/.hidden",
  "one.lock",
  "one/two.lock",
  "a b",
  "a\nb",
  "a\u0000b",
  "a\u007fb",
  "a~b",
  "a^b",
  "a:b",
  "a?b",
  "a*b",
  "a[b",
  "a\\b",
  "@",
  "a@{b",
])("refuses invalid branch %j", (branch) => {
  expect(
    planSchema.safeParse({
      trackerKey: "APP-1",
      assignments: [{ ...report, resources: "worktree", branch }],
    }).success,
  ).toBe(false);
});
test.each(["task/24-report", "feature", "report@host", "日本語"])(
  "accepts valid branch %s",
  (branch) => {
    expect(
      planSchema.parse({
        trackerKey: "APP-1",
        assignments: [{ ...report, resources: "worktree", branch }],
      }).assignments[0],
    ).toMatchObject({ branch });
  },
);
test.each(
  [
    [report, report],
    [{ ...report, dependencies: ["read"] }],
    [{ ...report, dependencies: ["missing"] }],
    [
      { ...report, dependencies: ["write"] },
      { ...report, key: "write", dependencies: ["read"] },
    ],
    [report, { ...report, key: "write", dependencies: ["read", "read"] }],
  ].map((assignments) => ({ assignments })),
)("rejects invalid dependency graphs $assignments", ({ assignments }) => {
  expect(planSchema.safeParse({ trackerKey: "APP-1", assignments }).success).toBe(false);
});
test("accepts an out-of-order diamond graph without reordering the supplied plan", () => {
  const assignments = [
    { ...report, key: "last", dependencies: ["left", "right"] },
    { ...report, key: "left", dependencies: ["read"] },
    report,
    { ...report, key: "right", dependencies: ["read"] },
  ];
  expect(
    planSchema
      .parse({ trackerKey: "APP-1", assignments })
      .assignments.map((assignment) => assignment.key),
  ).toEqual(["last", "left", "read", "right"]);
});
