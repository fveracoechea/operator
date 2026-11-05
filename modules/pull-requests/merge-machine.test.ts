import { expect, test } from "bun:test";
import type { Observation } from "./github.ts";
import {
  decideMerge,
  followMergeRequest,
  mergeRequestReads,
  verifiedMerge,
} from "./merge-machine.ts";

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
  checksComplete: true,
};

test("only a fresh observation with all five merge conditions and the local head merges", () => {
  expect(decideMerge({ stackRelayed: true, observed: eligible, localHead: "h1" })).toEqual({
    result: "merge",
    head: "h1",
    method: "squash",
  });
  expect(
    decideMerge({
      stackRelayed: true,
      observed: { ...eligible, mergeMethod: "rebase" },
      localHead: "h1",
    }),
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
    const decision = decideMerge({
      stackRelayed: true,
      observed: { ...eligible, ...change },
      localHead: "h1",
    });
    expect(decision).toMatchObject({ result: "refused", reason: "pr_merge_blocked" });
    expect("detail" in decision ? decision.detail : "").toContain(text);
  }
});

test("a stacked PR whose relay has not finished does not merge, even on the default branch", () => {
  const decision = decideMerge({ observed: eligible, localHead: "h1", stackRelayed: false });
  expect(decision).toMatchObject({
    result: "refused",
    reason: "pr_merge_blocked",
    conditions: { defaultBase: true, stackRelayed: false },
  });
  expect("detail" in decision ? decision.detail : "").toContain("a finished parent-merge relay");
  expect(decideMerge({ observed: eligible, localHead: "h1", stackRelayed: true })).toMatchObject({
    result: "merge",
  });
});

test("a different local head and a closed PR refuse, and a merged PR is only verified", () => {
  expect(decideMerge({ stackRelayed: true, observed: eligible, localHead: "h0" })).toMatchObject({
    result: "refused",
    reason: "pr_head_mismatch",
  });
  expect(decideMerge({ stackRelayed: true, observed: eligible, localHead: null })).toMatchObject({
    reason: "pr_head_mismatch",
  });
  expect(
    decideMerge({
      stackRelayed: true,
      observed: { ...eligible, state: "CLOSED" },
      localHead: "h1",
    }),
  ).toMatchObject({ result: "refused", reason: "pr_not_open" });
  // A merged PR needs no gate, because no merge request follows.
  expect(
    decideMerge({
      stackRelayed: true,
      observed: { ...eligible, state: "MERGED", approved: false },
      localHead: "h0",
    }),
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

test("each refusal names every missing condition and carries the observed conditions", () => {
  const nothing = "Nothing was merged or changed.";
  const none = {
    approved: false,
    checksPassing: false,
    threadsResolved: false,
    defaultBase: false,
    stackRelayed: false,
  };
  const blocked = {
    ...eligible,
    approved: false,
    checks: [],
    unresolvedThreads: 2,
    base: "release",
  };
  expect(decideMerge({ observed: blocked, localHead: "h1", stackRelayed: false })).toEqual({
    result: "refused",
    reason: "pr_merge_blocked",
    detail: `The PR needs an approving review decision, at least one check with every check passing, no unresolved review thread, the default branch as base, a finished parent-merge relay. ${nothing}`,
    conditions: none,
  });
  expect(
    decideMerge({
      observed: { ...blocked, state: "CLOSED" },
      localHead: "h1",
      stackRelayed: false,
    }),
  ).toEqual({
    result: "refused",
    reason: "pr_not_open",
    detail: `The PR is closed without a merge. Ask the SuperAgent. ${nothing}`,
    conditions: none,
  });
  const met = {
    approved: true,
    checksPassing: true,
    threadsResolved: true,
    defaultBase: true,
    stackRelayed: true,
  };
  expect(decideMerge({ stackRelayed: true, observed: eligible, localHead: null })).toEqual({
    result: "refused",
    reason: "pr_head_mismatch",
    detail: `The PR head is h1, but the worktree is at no commit. Push or reconcile first. ${nothing}`,
    conditions: met,
  });
  expect(decideMerge({ observed: eligible, localHead: "h0", stackRelayed: true })).toMatchObject({
    detail: `The PR head is h1, but the worktree is at h0. Push or reconcile first. ${nothing}`,
  });
});

test("a single missing condition is named alone", () => {
  expect(
    decideMerge({
      stackRelayed: true,
      observed: { ...eligible, unresolvedThreads: 1 },
      localHead: "h1",
    }),
  ).toMatchObject({
    detail: "The PR needs no unresolved review thread. Nothing was merged or changed.",
  });
});

test("a background merge request is read while it runs, and every end is verified", () => {
  const request = { uuid: "u1", message: "Done." };
  expect(followMergeRequest({ ...request, status: "pending" }, 0)).toEqual({
    result: "read",
    uuid: "u1",
  });
  expect(followMergeRequest({ ...request, status: "pending" }, mergeRequestReads - 1)).toEqual({
    result: "read",
    uuid: "u1",
  });
  expect(followMergeRequest({ ...request, status: "merged" }, 0)).toEqual({
    result: "verify",
    refusal: null,
  });
  expect(followMergeRequest({ ...request, status: "failed" }, 3)).toEqual({
    result: "verify",
    refusal: { reason: "pr_merge_refused", detail: "Done." },
  });
  expect(followMergeRequest({ ...request, status: "enqueued" }, 0)).toEqual({
    result: "verify",
    refusal: {
      reason: "pr_merge_unverified",
      detail:
        "GitHub put the PR in a merge queue: Done. Nothing was recorded. Repeat operator pr merge after it merges.",
    },
  });
  const running = {
    result: "verify" as const,
    refusal: {
      reason: "pr_merge_unverified",
      detail:
        "GitHub still runs the merge request: Done. Nothing was recorded. Repeat operator pr merge.",
    },
  };
  expect(followMergeRequest({ ...request, status: "pending" }, mergeRequestReads)).toEqual(running);
  expect(followMergeRequest({ ...request, uuid: null, status: "pending" }, 0)).toEqual(running);
  expect(mergeRequestReads).toBe(120);
});
