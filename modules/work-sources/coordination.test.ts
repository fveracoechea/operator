import { expect, test } from "bun:test";
import { actionSet } from "./coordination.ts";

const ready = { action: "ready_assignment", reason: "dependencies_met", assignment: "b" };
const ended = { action: "source_ended", reason: "finished" };
const report = { action: "review_report", reason: "report_submitted", assignment: "a" };

function answer(...sources: [string, object[]][]) {
  return {
    sources: sources.map(([id, actions]) => ({
      id,
      actions: actions as { action: string; reason?: string; assignment?: string }[],
    })),
  };
}

test("the set names each action by source, assignment, action, and reason in a fixed order", () => {
  expect(JSON.parse(actionSet(answer(["s2", [report]], ["s1", [ended, ready]])))).toEqual([
    ["s1", "b", "ready_assignment", "dependencies_met"],
    ["s1", null, "source_ended", "finished"],
    ["s2", "a", "review_report", "report_submitted"],
  ]);
  expect(actionSet(answer())).toBe("[]");
});

test("order, repetition, and recorded facts beside an action leave the set unchanged", () => {
  const base = actionSet(answer(["s1", [ready, ended]], ["s2", [report]]));
  expect(
    actionSet(answer(["s2", [report]], ["s1", [{ ...ended, endedAt: "later" }, ready, ready]])),
  ).toBe(base);
  expect(
    actionSet(answer(["s1", [{ ...ready, launch: { state: "idle" } }, ended]], ["s2", [report]])),
  ).toBe(base);
});

test("a new action, a new reason, a removed action, or another source changes the set", () => {
  const base = actionSet(answer(["s1", [ready]]));
  expect(actionSet(answer(["s1", [ready, ended]]))).not.toBe(base);
  expect(actionSet(answer(["s1", []]))).not.toBe(base);
  expect(actionSet(answer(["s1", [{ ...ready, reason: "replacement" }]]))).not.toBe(base);
  expect(actionSet(answer(["s1", [{ ...ready, assignment: "c" }]]))).not.toBe(base);
  expect(actionSet(answer(["s2", [ready]]))).not.toBe(base);
});
