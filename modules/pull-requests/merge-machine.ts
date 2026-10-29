import type { Observation } from "./github.ts";
import { mergeConditions, type MergeConditions } from "./wait-machine.ts";

// A stacked PR merges only after its parent merged and its relay finished.
type Facts = { observed: Observation; localHead: string | null; stackRelayed: boolean };
type Refusal = {
  result: "refused";
  reason: "pr_not_open" | "pr_merge_blocked" | "pr_head_mismatch";
  detail: string;
  conditions: MergeConditions;
};
type Decision =
  | { result: "merge"; head: string; method: Observation["mergeMethod"] }
  | { result: "verify" }
  | Refusal;

const nothing = "Nothing was merged or changed.";

function blocked(conditions: MergeConditions) {
  const missing = [
    conditions.approved ? null : "an approving review decision",
    conditions.checksPassing ? null : "at least one check with every check passing",
    conditions.threadsResolved ? null : "no unresolved review thread",
    conditions.defaultBase ? null : "the default branch as base",
    conditions.stackRelayed ? null : "a finished parent-merge relay",
  ].filter((text) => text !== null);
  return `The PR needs ${missing.join(", ")}. ${nothing}`;
}

const rules: { when: (facts: Facts) => boolean; decide: (facts: Facts) => Decision }[] = [
  {
    when: ({ observed }) => observed.state === "CLOSED",
    decide: ({ observed, stackRelayed }) => ({
      result: "refused",
      reason: "pr_not_open",
      detail: `The PR is closed without a merge. Ask the SuperAgent. ${nothing}`,
      conditions: mergeConditions(observed, stackRelayed),
    }),
  },
  // A merge that already happened, for example after a lost answer, is verified, not repeated.
  {
    when: ({ observed }) => observed.state === "MERGED",
    decide: () => ({ result: "verify" }),
  },
  {
    when: ({ observed, stackRelayed }) =>
      !Object.values(mergeConditions(observed, stackRelayed)).every(Boolean),
    decide: ({ observed, stackRelayed }) => ({
      result: "refused",
      reason: "pr_merge_blocked",
      detail: blocked(mergeConditions(observed, stackRelayed)),
      conditions: mergeConditions(observed, stackRelayed),
    }),
  },
  // The owner merges what its worktree holds, so local commits cannot become unlanded work.
  {
    when: ({ observed, localHead }) => localHead !== observed.head,
    decide: ({ observed, localHead, stackRelayed }) => ({
      result: "refused",
      reason: "pr_head_mismatch",
      detail: `The PR head is ${observed.head}, but the worktree is at ${localHead ?? "no commit"}. Push or reconcile first. ${nothing}`,
      conditions: mergeConditions(observed, stackRelayed),
    }),
  },
];

/**
 * The PR merge gate over a fresh observation. A wait result or a supervisor's claim is never an
 * input, so only GitHub's current approval, checks, threads, and base permit the merge.
 */
export function decideMerge(facts: Facts): Decision {
  return (
    rules.find((rule) => rule.when(facts))?.decide(facts) ?? {
      result: "merge",
      head: facts.observed.head,
      method: facts.observed.mergeMethod,
    }
  );
}

/** Only GitHub's merged state with a merge commit for the expected head proves completion. */
export function verifiedMerge(observed: Observation, head: string | null) {
  return observed.state === "MERGED" &&
    observed.mergeCommit !== null &&
    (head === null || observed.head === head)
    ? { head: observed.head, mergeCommit: observed.mergeCommit }
    : null;
}
