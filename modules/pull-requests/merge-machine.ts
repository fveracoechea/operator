import type { Observation } from "./github.ts";
import { mergeConditions, type MergeConditions } from "./wait-machine.ts";

// A stacked PR merges only after its parent merged and its relay finished, and a PR with an
// internal review only after that review ended ready or skipped.
type Facts = {
  observed: Observation;
  localHead: string | null;
  stackRelayed: boolean;
  reviewEnded: boolean;
};
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
    conditions.reviewEnded ? null : "an internal review that ended ready or skipped",
  ].filter((text) => text !== null);
  return `The PR needs ${missing.join(", ")}. ${nothing}`;
}

const rules: { when: (facts: Facts) => boolean; decide: (facts: Facts) => Decision }[] = [
  {
    when: ({ observed }) => observed.state === "CLOSED",
    decide: (facts) => ({
      result: "refused",
      reason: "pr_not_open",
      detail: `The PR is closed without a merge. Ask the SuperAgent. ${nothing}`,
      conditions: mergeConditions(facts.observed, facts),
    }),
  },
  // A merge that already happened, for example after a lost answer, is verified, not repeated.
  {
    when: ({ observed }) => observed.state === "MERGED",
    decide: () => ({ result: "verify" }),
  },
  {
    when: (facts) => !Object.values(mergeConditions(facts.observed, facts)).every(Boolean),
    decide: (facts) => ({
      result: "refused",
      reason: "pr_merge_blocked",
      detail: blocked(mergeConditions(facts.observed, facts)),
      conditions: mergeConditions(facts.observed, facts),
    }),
  },
  // The owner merges what its worktree holds, so local commits cannot become unlanded work.
  {
    when: ({ observed, localHead }) => localHead !== observed.head,
    decide: (facts) => ({
      result: "refused",
      reason: "pr_head_mismatch",
      detail: `The PR head is ${facts.observed.head}, but the worktree is at ${facts.localHead ?? "no commit"}. Push or reconcile first. ${nothing}`,
      conditions: mergeConditions(facts.observed, facts),
    }),
  },
];

/**
 * The PR merge gate over a fresh observation. A wait result or a supervisor's claim is never an
 * input, so only GitHub's current approval, checks, threads, and base, with the recorded end of
 * any internal review, permit the merge.
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
