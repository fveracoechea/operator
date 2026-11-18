import { expect, test } from "bun:test";
import { refusesPrGuard } from "./pr-policy.ts";

test("PR ownership remains with a launch only before handoff", () => {
  expect(refusesPrGuard({ guard: "ownership", handedOff: false })).toBe(false);
  expect(refusesPrGuard({ guard: "ownership", handedOff: true })).toBe(true);
});

test.each([
  [0, false],
  [1, false],
  [2, true],
  [3, true],
] as const)("the PR round policy refuses round count %i: %p", (rounds, refused) => {
  expect(refusesPrGuard({ guard: "round", rounds })).toBe(refused);
});

test("PR worktree policy refuses changed or untracked work", () => {
  expect(refusesPrGuard({ guard: "worktree_clean", changed: false })).toBe(false);
  expect(refusesPrGuard({ guard: "worktree_clean", changed: true })).toBe(true);
});
