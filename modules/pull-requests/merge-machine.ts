import type { Observation } from "./github.ts";
import { mergeConditions, type MergeConditions } from "./wait-machine.ts";

type Facts = { observed: Observation; localHead: string | null };
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
  ].filter((text) => text !== null);
  return `The PR needs ${missing.join(", ")}. ${nothing}`;
}

const rules: { when: (facts: Facts) => boolean; decide: (facts: Facts) => Decision }[] = [
  {
    when: ({ observed }) => observed.state === "CLOSED",
    decide: ({ observed }) => ({
      result: "refused",
      reason: "pr_not_open",
      detail: `The PR is closed without a merge. Ask the SuperAgent. ${nothing}`,
      conditions: mergeConditions(observed),
    }),
  },
  // A merge that already happened, for example after a lost answer, is verified, not repeated.
  { when: ({ observed }) => observed.state === "MERGED", decide: () => ({ result: "verify" }) },
  {
    when: ({ observed }) => !Object.values(mergeConditions(observed)).every(Boolean),
    decide: ({ observed }) => ({
      result: "refused",
      reason: "pr_merge_blocked",
      detail: blocked(mergeConditions(observed)),
      conditions: mergeConditions(observed),
    }),
  },
  // The owner merges what its worktree holds, so local commits cannot become unlanded work.
  {
    when: ({ observed, localHead }) => localHead !== observed.head,
    decide: ({ observed, localHead }) => ({
      result: "refused",
      reason: "pr_head_mismatch",
      detail: `The PR head is ${observed.head}, but the worktree is at ${localHead ?? "no commit"}. Push or reconcile first. ${nothing}`,
      conditions: mergeConditions(observed),
    }),
  },
  {
    when: () => true,
    decide: ({ observed }) => ({
      result: "merge",
      head: observed.head,
      method: observed.mergeMethod,
    }),
  },
];

/**
 * The PR merge gate over a fresh observation. A wait result or a supervisor's claim is never an
 * input, so only GitHub's current approval, checks, threads, and base permit the merge.
 */
export function decideMerge(facts: Facts): Decision {
  for (const rule of rules) if (rule.when(facts)) return rule.decide(facts);
  // oxlint-disable-next-line unthrown/no-throw -- The final rule is unconditional, so this is a programming defect.
  throw new Error("The merge table has no matching rule.");
}

/** Only GitHub's merged state with a merge commit for the expected head proves completion. */
export function verifiedMerge(observed: Observation, head: string | null) {
  return observed.state === "MERGED" &&
    observed.mergeCommit !== null &&
    (head === null || observed.head === head)
    ? { head: observed.head, mergeCommit: observed.mergeCommit }
    : null;
}
