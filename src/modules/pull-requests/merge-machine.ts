import type { MergeRequest, Observation } from "./github.ts";
import { mergeConditions, type MergeConditions } from "./wait-machine.ts";
import type { RefusalContext, Refusal as Failure } from "../../lib/cli-result.ts";

// A stacked PR requires its finished relay; every PR requires its recorded ready transition.
type Facts = {
  observed: Observation;
  localHead: string | null;
  stackRelayed: boolean;
  reviewEnded: boolean;
};
type Refusal = RefusalContext & {
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
    conditions.notDraft ? null : "the ready-for-review state",
    conditions.stackRelayed ? null : "a finished parent-merge relay",
    conditions.reviewEnded ? null : "a recorded ready transition (pr_ready)",
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
      next: {
        decider: "super-agent",
        question: "How should the closed PR assignment be resolved?",
      },
      state: { pullRequest: "CLOSED" },
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
      next: { command: "operator pr wait", why: blocked(mergeConditions(facts.observed, facts)) },
      state: { conditions: mergeConditions(facts.observed, facts) },
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
      next: {
        decider: "super-agent",
        question: "How should the worktree and PR heads be reconciled without losing commits?",
      },
      state: { localHead: facts.localHead, prHead: facts.observed.head },
      conditions: mergeConditions(facts.observed, facts),
    }),
  },
];

/**
 * The PR merge gate over a fresh observation. A wait result or a supervisor's claim is never an
 * input, so only GitHub's current approval, checks, threads, base, and draft state, with the
 * recorded ready transition, permit the merge.
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

// The background merge gets two minutes of reads, one each second, before the owner repeats it.
export const mergeRequestReads = 120;

export const mergeRequestReadMs = 1000;

type MergeRequestStep =
  | { result: "read"; uuid: string }
  | { result: "verify"; refusal: Failure | null };

/**
 * The next step after one state of a background merge request. Every final state and every
 * stopped read is verified against the PR, because only GitHub's merged PR proves the merge.
 */
export function followMergeRequest(request: MergeRequest, reads: number): MergeRequestStep {
  if (request.status === "merged") return { result: "verify", refusal: null };
  if (request.status === "failed")
    return {
      result: "verify",
      refusal: {
        reason: "pr_merge_refused",
        detail: request.message,
        next: {
          decider: "person",
          question: "Which GitHub merge restriction must be resolved before this PR can merge?",
        },
      },
    };
  if (request.status === "enqueued")
    return {
      result: "verify",
      refusal: {
        reason: "pr_merge_unverified",
        detail: `GitHub put the PR in a merge queue: ${request.message} Nothing was recorded. Repeat operator pr merge after it merges.`,
        next: {
          command: "operator pr merge",
          why: "Verify the queued merge after GitHub reports it merged.",
        },
        state: { mergeRequest: request.status },
      },
    };
  if (request.uuid !== null && reads < mergeRequestReads)
    return { result: "read", uuid: request.uuid };
  return {
    result: "verify",
    refusal: {
      reason: "pr_merge_unverified",
      detail: `GitHub still runs the merge request: ${request.message} Nothing was recorded. Repeat operator pr merge.`,
      next: {
        command: "operator pr merge",
        why: "Verify whether the background merge request landed.",
      },
      state: { mergeRequest: request.status },
    },
  };
}
