// The internal review of a PR assignment: reviewing with at most two rounds, then ready or
// skipped. This decides the associate, handoff, and round events. ADR-0003, ADR-0020.
type Review = { state: string; rounds: { head: string }[] };

type AssociateFacts = {
  event: "associate";
  /** The resolved internal review value of the associating launch. */
  internalReview: boolean;
  draft: boolean;
  /** Uncommitted changes or untracked files in the worktree. */
  changed: boolean;
  localHead: string | null;
  prHead: string;
};
type HandoffFacts = {
  event: "handoff";
  implementer: { state: string; paneId: string | null };
  /** A launch after the implementer's exists, so the reviewer started. */
  reviewerStarted: boolean;
};
type RoundFacts = {
  event: "round";
  review: Review;
  /** The launch that the handoff ended. It no longer owns the PR. */
  implementer: boolean;
  localHead: string | null;
};
type Facts = AssociateFacts | HandoffFacts | RoundFacts;

type Refusal = { result: "refused"; reason: string; detail: string };
type Decision =
  | Refusal
  | { result: "associate"; review: boolean }
  | { result: "handoff"; closePane: boolean; dispatch: boolean }
  | { result: "round"; number: number; head: string };
type Rule<F> = { when: (facts: F) => boolean; refuse: (facts: F) => Refusal };

const unchanged = "Nothing was changed.";

function refused(reason: string, detail: string): Refusal {
  return { result: "refused", reason, detail };
}

// With internal review off, the association behaves as before ADR-0020.
const associateRules: Rule<AssociateFacts>[] = [
  // A ready PR would skip the review, so only a draft starts one.
  {
    when: (facts) => facts.internalReview && !facts.draft,
    refuse: () =>
      refused(
        "pr_draft_required",
        `Internal review is on, so the PR must be a draft. Convert it with gh pr ready --undo, then associate again. ${unchanged}`,
      ),
  },
  // The reviewer reads exactly the PR, so no work may stay outside it.
  {
    when: (facts) => facts.internalReview && facts.changed,
    refuse: () =>
      refused(
        "pr_worktree_unclean",
        `Commit or remove the changed and untracked files, push, then associate again. ${unchanged}`,
      ),
  },
  {
    when: (facts) => facts.internalReview && facts.localHead !== facts.prHead,
    refuse: (facts) =>
      refused(
        "pr_worktree_unsynced",
        `The worktree is at ${facts.localHead ?? "no commit"}, but the PR head is ${facts.prHead}. Push, then associate again. ${unchanged}`,
      ),
  },
];

const roundRules: Rule<RoundFacts>[] = [
  {
    when: (facts) => facts.implementer,
    refuse: () =>
      refused(
        "pr_handed_off",
        `This launch handed the PR to its internal reviewer. Stop here. ${unchanged}`,
      ),
  },
  {
    when: (facts) => facts.review.state !== "reviewing",
    refuse: () =>
      refused(
        "internal_review_ended",
        `The internal review has ended, so it takes no more rounds. ${unchanged}`,
      ),
  },
  {
    when: (facts) => facts.review.rounds.length >= 2,
    refuse: () =>
      refused(
        "internal_review_round_limit",
        `The internal review already has two rounds, its limit. Decide each open finding instead. ${unchanged}`,
      ),
  },
  // A second round reviews the fixes of the first, so it needs a newer head.
  {
    when: (facts) => facts.review.rounds.some((round) => round.head === facts.localHead) === true,
    refuse: (facts) =>
      refused(
        "internal_review_round_head",
        // Stryker disable next-line StringLiteral: equivalent: this rule matches only a head that round 1 recorded, so the head is never null
        `Round 1 already reviewed ${facts.localHead ?? ""}. Commit and push its fixes, then record round 2. ${unchanged}`,
      ),
  },
];

function associate(facts: AssociateFacts): Decision {
  return (
    associateRules.find((rule) => rule.when(facts))?.refuse(facts) ?? {
      result: "associate",
      review: facts.internalReview,
    }
  );
}

/**
 * The handoff closes the implementer's pane while its session runs, then starts the reviewer
 * unless a later launch already did. A repeated handoff skips each finished step.
 */
function handoff(facts: HandoffFacts): Decision {
  const live = ["starting", "running"].includes(facts.implementer.state);
  return {
    result: "handoff",
    closePane: !facts.reviewerStarted && live && facts.implementer.paneId !== null,
    dispatch: !facts.reviewerStarted,
  };
}

function round(facts: RoundFacts): Decision {
  const refusal = roundRules.find((rule) => rule.when(facts))?.refuse(facts);
  if (refusal !== undefined) return refusal;
  if (facts.localHead === null)
    return refused("internal_review_head_missing", `The worktree has no commit. ${unchanged}`);
  return { result: "round", number: facts.review.rounds.length + 1, head: facts.localHead };
}

export function decideInternalReview(facts: Facts): Decision {
  if (facts.event === "associate") return associate(facts);
  return facts.event === "handoff" ? handoff(facts) : round(facts);
}
