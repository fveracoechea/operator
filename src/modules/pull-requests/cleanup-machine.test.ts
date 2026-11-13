import { expect, test } from "bun:test";
import {
  cleanupSteps,
  decidePane,
  decideRemoteBranch,
  decideWorktree,
  nextStep,
  type WorktreeFacts,
} from "./cleanup-machine.ts";

test("the steps run in the declared order and end after the worktree", () => {
  expect(cleanupSteps).toEqual(["remote_branch", "pane", "worktree"]);
  expect(nextStep("remote_branch")).toBe("pane");
  expect(nextStep("pane")).toBe("worktree");
  expect(nextStep("worktree")).toBeNull();
});

test("a remote branch is deleted at the merged head and kept when it moved", () => {
  const facts = { branch: "task/1", mergedHead: "h1", personInstructed: false };
  expect(decideRemoteBranch({ ...facts, sha: "h1" })).toEqual({ action: "dispose", force: false });
  expect(decideRemoteBranch({ ...facts, sha: null })).toEqual({
    action: "skip",
    outcome: "absent",
  });
  expect(decideRemoteBranch({ ...facts, sha: "h2" })).toMatchObject({
    action: "blocked",
    reason: "cleanup_unlanded_work",
  });
  expect(decideRemoteBranch({ ...facts, sha: "h2", personInstructed: true })).toEqual({
    action: "dispose",
    force: true,
  });
});

test("only the recorded pane in its recorded tab is closed", () => {
  const recorded = { paneId: "w2:p1", tabId: "w2:t1" };
  expect(decidePane({ recorded, observed: { tabId: "w2:t1" } })).toEqual({
    action: "dispose",
    force: false,
  });
  expect(decidePane({ recorded, observed: null })).toEqual({ action: "skip", outcome: "absent" });
  expect(decidePane({ recorded, observed: { tabId: "w9:t1" } })).toEqual({
    action: "skip",
    outcome: "replaced",
  });
  expect(decidePane({ recorded: { paneId: null, tabId: null }, observed: null })).toEqual({
    action: "skip",
    outcome: "not_recorded",
  });
});

const clean: WorktreeFacts = {
  path: "/w",
  exists: true,
  sameRepository: true,
  branch: "task/1",
  expectedBranch: "task/1",
  landed: true,
  changed: [],
  unknownIgnored: [],
  personInstructed: false,
};

test("a clean recorded worktree is removed without force, and a gone one is observed", () => {
  expect(decideWorktree(clean)).toEqual({ action: "dispose", force: false });
  expect(decideWorktree({ ...clean, exists: false })).toEqual({
    action: "skip",
    outcome: "absent",
  });
  expect(decideWorktree({ ...clean, path: null })).toEqual({
    action: "skip",
    outcome: "not_recorded",
  });
});

test("unlanded work blocks until the person instructs a forced removal", () => {
  const cases: [Partial<WorktreeFacts>, string][] = [
    [{ landed: false }, "commits that are not in the merged head"],
    [{ changed: ["a.ts"] }, "changed or untracked a.ts"],
    [{ unknownIgnored: [".cache/"] }, "ignored content that preparation did not write: .cache/"],
  ];
  for (const [change, text] of cases) {
    const decision = decideWorktree({ ...clean, ...change });
    expect(decision).toMatchObject({ action: "blocked", reason: "cleanup_unlanded_work" });
    expect("detail" in decision ? decision.detail : "").toContain(text);
    expect(decideWorktree({ ...clean, ...change, personInstructed: true })).toEqual({
      action: "dispose",
      force: true,
    });
  }
  const many = decideWorktree({ ...clean, changed: Array.from({ length: 23 }, (_, i) => `f${i}`) });
  expect("detail" in many ? many.detail : "").toContain("and 3 more");
});

test("a foreign checkout is never removed, even on the person's instruction", () => {
  for (const change of [{ sameRepository: false }, { branch: "other" }, { branch: null }])
    for (const personInstructed of [false, true])
      expect(decideWorktree({ ...clean, ...change, personInstructed })).toMatchObject({
        action: "blocked",
        reason: "cleanup_resource_mismatch",
      });
});

test("each blocked decision explains what the person must do", () => {
  const person =
    "Only the person can authorize its deletion: repeat operator cleanup with --person-instructed on the person's instruction.";
  expect(
    decideRemoteBranch({ branch: "task/1", sha: "h2", mergedHead: "h1", personInstructed: false }),
  ).toEqual({
    action: "blocked",
    reason: "cleanup_unlanded_work",
    detail: `The remote branch task/1 is at h2, not at the merged head h1. ${person}`,
  });
  expect(decideWorktree({ ...clean, branch: "other" })).toEqual({
    action: "blocked",
    reason: "cleanup_resource_mismatch",
    detail:
      "/w is no longer the recorded worktree on task/1. Operator never removes another checkout. Move it away, then repeat operator cleanup.",
  });
  expect(
    decideWorktree({ ...clean, landed: false, changed: ["a", "b"], unknownIgnored: ["c/"] }),
  ).toEqual({
    action: "blocked",
    reason: "cleanup_unlanded_work",
    detail: `/w holds commits that are not in the merged head; changed or untracked a, b; ignored content that preparation did not write: c/. ${person}`,
  });
  function names(count: number) {
    return Array.from({ length: count }, (_, i) => `f${i}`);
  }
  function listed(count: number) {
    const decision = decideWorktree({ ...clean, changed: names(count) });
    return "detail" in decision ? decision.detail : "";
  }
  expect(listed(20)).toBe(`/w holds changed or untracked ${names(20).join(", ")}. ${person}`);
  expect(listed(21)).toBe(
    `/w holds changed or untracked ${names(20).join(", ")}, and 1 more. ${person}`,
  );
});
