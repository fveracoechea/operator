import { expect, test } from "bun:test";
import { finish, inspect, request, stateSchema } from "./model.ts";
import { decide } from "./table.ts";
import { facts, pr, report } from "./cases.fixture.ts";

test("closed assignment states reject crossed completion contracts", () => {
  expect(stateSchema.safeParse({ ...report, phase: "merged" }).success).toBe(false);
  expect(stateSchema.safeParse({ ...pr, phase: "completed" }).success).toBe(false);
});

test("completion result handling cannot create completion without an operation", () => {
  expect(finish(pr, facts)).toMatchObject({
    status: "refused",
    reason: "no-operation",
    state: pr,
    effects: [],
  });
  const invalid = request(report, "merge-pr");
  expect(finish(invalid.state, facts)).toMatchObject({
    status: "refused",
    reason: "wrong-completion",
    effects: [],
  });
});

test("next actions use the same decision, not a second merge gate", () => {
  expect(inspect(decide, pr, facts).nextActions).toContain("merge");
  expect(inspect(decide, pr, { ...facts, approved: false }).nextActions).not.toContain("merge");
});
