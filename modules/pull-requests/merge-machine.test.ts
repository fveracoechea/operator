import { expect, test } from "bun:test";
import type { Observation } from "./github.ts";
import { decideMerge, verifiedMerge } from "./merge-machine.ts";

const eligible: Observation = {
  state: "OPEN",
  head: "h1",
  mergeCommit: null,
  mergeMethod: "squash",
  base: "main",
  defaultBranch: "main",
  approved: true,
  unresolvedThreads: 0,
  feedback: [],
  checks: [{ name: "lint", state: "passing", url: null }],
};

test("only a fresh observation with all four merge conditions and the local head merges", () => {
  expect(decideMerge({ observed: eligible, localHead: "h1" })).toEqual({
    result: "merge",
    head: "h1",
    method: "squash",
  });
  expect(
    decideMerge({ observed: { ...eligible, mergeMethod: "rebase" }, localHead: "h1" }),
  ).toMatchObject({ result: "merge", method: "rebase" });
});

test("each missing condition refuses with its own explanation", () => {
  const cases: [Partial<Observation>, string][] = [
    [{ approved: false }, "an approving review decision"],
    [{ checks: [] }, "at least one check"],
    [{ checks: [{ name: "lint", state: "pending", url: null }] }, "at least one check"],
    [{ checks: [{ name: "lint", state: "failing", url: null }] }, "at least one check"],
    [{ unresolvedThreads: 1 }, "no unresolved review thread"],
    [{ base: "release" }, "the default branch as base"],
    [{ defaultBranch: null }, "the default branch as base"],
  ];
  for (const [change, text] of cases) {
    const decision = decideMerge({ observed: { ...eligible, ...change }, localHead: "h1" });
    expect(decision).toMatchObject({ result: "refused", reason: "pr_merge_blocked" });
    expect("detail" in decision ? decision.detail : "").toContain(text);
  }
});

test("a different local head and a closed PR refuse, and a merged PR is only verified", () => {
  expect(decideMerge({ observed: eligible, localHead: "h0" })).toMatchObject({
    result: "refused",
    reason: "pr_head_mismatch",
  });
  expect(decideMerge({ observed: eligible, localHead: null })).toMatchObject({
    reason: "pr_head_mismatch",
  });
  expect(
    decideMerge({ observed: { ...eligible, state: "CLOSED" }, localHead: "h1" }),
  ).toMatchObject({ result: "refused", reason: "pr_not_open" });
  // A merged PR needs no gate, because no merge request follows.
  expect(
    decideMerge({ observed: { ...eligible, state: "MERGED", approved: false }, localHead: "h0" }),
  ).toEqual({ result: "verify" });
});

test("verification needs GitHub's merged state, a merge commit, and the guarded head", () => {
  const merged = { ...eligible, state: "MERGED" as const, mergeCommit: "m1" };
  expect(verifiedMerge(merged, "h1")).toEqual({ head: "h1", mergeCommit: "m1" });
  expect(verifiedMerge(merged, null)).toEqual({ head: "h1", mergeCommit: "m1" });
  expect(verifiedMerge(merged, "h2")).toBeNull();
  expect(verifiedMerge({ ...merged, mergeCommit: null }, "h1")).toBeNull();
  expect(verifiedMerge({ ...eligible, mergeCommit: "m1" }, "h1")).toBeNull();
});
