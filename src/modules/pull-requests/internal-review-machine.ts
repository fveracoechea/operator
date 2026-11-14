// The internal review of a PR assignment: reviewing with at most two rounds, then ready or
// skipped. This decides the associate, handoff, round, ready, and skip events. ADR-0003, ADR-0020.
import type { ResultContext } from "../../lib/cli-result.ts";

type Review = { state: string; rounds: { head: string }[] };
type Disposition = { round: number; finding: number; disposition: "applied" | "declined" };
type PullRequest = { state: string; head: string; draft: boolean };

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
type ReadyFacts = {
  event: "ready";
  review: { state: string; rounds: { head: string; findings: { severity: string }[] }[] };
  implementer: boolean;
  dispositions: Disposition[];
  changed: boolean;
  localHead: string | null;
  pr: PullRequest;
  /**
   * This review's summary comment on GitHub: none, the same text as now, or an older text, for
   * example after a lost answer and a later push.
   */
  posted: "none" | "current" | "stale";
};
type SkipFacts = {
  event: "skip";
  personInstructed: boolean;
  /** The recorded review state, or null when the assignment has none. */
  review: string | null;
  /** GitHub is read only for a skip that the local facts permit. */
  pr: PullRequest | null;
};
type Facts = AssociateFacts | HandoffFacts | RoundFacts | ReadyFacts | SkipFacts;

type Refusal = ResultContext & { result: "refused"; reason: string; detail: string };
type Decision =
  | Refusal
  | { result: "associate"; review: boolean }
  | { result: "handoff"; closePane: boolean; dispatch: boolean }
  | { result: "round"; number: number; head: string }
  | { result: "ready"; head: string; comment: "post" | "update" | "keep"; markReady: boolean }
  | { result: "skip"; head: string; markReady: boolean };
type Rule<F> = { when: (facts: F) => boolean; refuse: (facts: F) => Refusal };

const unchanged = "Nothing was changed.";

function refused(reason: string, detail: string, context: ResultContext = {}): Refusal {
  return { result: "refused", reason, detail, ...context };
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

/** The launch that the handoff ended no longer owns the PR, also while its pane still runs. */
export function decideOwnership(facts: { implementer: boolean }): Refusal | null {
  return facts.implementer
    ? refused(
        "pr_handed_off",
        `This launch handed the PR to its internal reviewer, so it runs no more PR commands. Stop here. ${unchanged}`,
      )
    : null;
}

const roundRules: Rule<RoundFacts>[] = [
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
    when: (facts) => facts.review.rounds.some((round) => round.head === facts.localHead),
    refuse: (facts) =>
      refused(
        "internal_review_round_head",
        // Stryker disable next-line StringLiteral: equivalent: this rule matches only a head that round 1 recorded, so the head is never null
        `Round 1 already reviewed ${facts.localHead ?? ""}. Commit and push its fixes, then record round 2. ${unchanged}`,
      ),
  },
];

function key({ round, finding }: { round: number; finding: number }) {
  return `${round}.${finding}`;
}

/** Each recorded finding as round.finding, numbered from 1 in the order of its round file. */
function recorded(facts: ReadyFacts) {
  return facts.review.rounds.flatMap((round, index) =>
    round.findings.map((finding, position) => ({
      key: key({ round: index + 1, finding: position + 1 }),
      blocker: finding.severity === "blocker",
    })),
  );
}

function unknown(facts: ReadyFacts) {
  const keys = recorded(facts).map((finding) => finding.key);
  return facts.dispositions.map(key).filter((item) => !keys.includes(item));
}

function repeated(facts: ReadyFacts) {
  const keys = facts.dispositions.map(key);
  return keys.filter((item, index) => keys.indexOf(item) !== index);
}

function undecided(facts: ReadyFacts) {
  const keys = facts.dispositions.map(key);
  return recorded(facts)
    .map((finding) => finding.key)
    .filter((item) => !keys.includes(item));
}

const readyRules: Rule<ReadyFacts>[] = [
  {
    when: (facts) => facts.review.state !== "reviewing",
    refuse: (facts) =>
      refused(
        "internal_review_ended",
        `The internal review already ended ${facts.review.state}. You own the PR, so run operator pr wait --json. ${unchanged}`,
      ),
  },
  {
    when: (facts) => facts.pr.state !== "OPEN",
    refuse: () => refused("pr_not_open", `The PR is not open. Ask the SuperAgent. ${unchanged}`),
  },
  {
    when: (facts) => facts.review.rounds.length === 0,
    refuse: () =>
      refused(
        "internal_review_round_missing",
        `Record at least one round with operator pr round --file <findings.json> --json. ${unchanged}`,
      ),
  },
  {
    when: (facts) => unknown(facts).length > 0,
    refuse: (facts) =>
      refused(
        "internal_review_summary_invalid",
        `No recorded finding is ${unknown(facts).join(", ")}. Name each finding as round and finding number. ${unchanged}`,
      ),
  },
  {
    when: (facts) => repeated(facts).length > 0,
    refuse: (facts) =>
      refused(
        "internal_review_summary_invalid",
        `Findings ${repeated(facts).join(", ")} have more than one disposition. ${unchanged}`,
      ),
  },
  // The comment states every recorded finding, so none can drop out of the public trace.
  {
    when: (facts) => undecided(facts).length > 0,
    refuse: (facts) =>
      refused(
        "internal_review_summary_incomplete",
        `Findings ${undecided(facts).join(", ")} have no disposition. Apply or decline each recorded finding. ${unchanged}`,
      ),
  },
  // The reviewer's own blocker fixes need a review at a newer head.
  {
    when: (facts) =>
      facts.review.rounds.length === 1 &&
      facts.dispositions.some(
        (item) =>
          item.disposition === "applied" &&
          recorded(facts).some((finding) => finding.key === key(item) && finding.blocker),
      ),
    refuse: () =>
      refused(
        "internal_review_second_round_required",
        `Round 1 had a blocker that you applied, so its fixes need round 2. Push them, then record round 2 with a fresh subagent. ${unchanged}`,
      ),
  },
  // The comment describes the code on GitHub, so the worktree holds exactly the PR head.
  {
    when: (facts) => facts.changed,
    refuse: () =>
      refused(
        "pr_worktree_unclean",
        `Commit or remove the changed and untracked files, push, then run operator pr ready again. ${unchanged}`,
      ),
  },
  {
    when: (facts) => facts.localHead !== facts.pr.head,
    refuse: (facts) =>
      refused(
        "pr_worktree_unsynced",
        `The worktree is at ${facts.localHead ?? "no commit"}, but the PR head is ${facts.pr.head}. Push, then run operator pr ready again. ${unchanged}`,
      ),
  },
];

const skipRules: Rule<SkipFacts>[] = [
  {
    when: (facts) => !facts.personInstructed,
    refuse: () =>
      refused(
        "person_instruction_required",
        `Skip an internal review only on the person's explicit instruction. --person-instructed attests that instruction, it does not grant authority. ${unchanged}`,
        {
          next: {
            decider: "person",
            question: "May this command run on your explicit instruction?",
          },
          state: { personInstructed: false },
        },
      ),
  },
  {
    when: (facts) => facts.review === null,
    refuse: () =>
      refused(
        "internal_review_not_recorded",
        `The assignment has no internal review to skip. ${unchanged}`,
        { next: { why: "No internal review exists to skip." }, state: { review: null } },
      ),
  },
  {
    when: (facts) => facts.review !== "reviewing",
    refuse: (facts) =>
      refused(
        "internal_review_ended",
        // Stryker disable next-line StringLiteral: equivalent: this rule matches only a recorded review, so its state is never null
        `The internal review already ended ${facts.review ?? ""}. ${unchanged}`,
        {
          next: { why: "The internal review has already ended. No skip remains." },
          state: { review: facts.review },
        },
      ),
  },
  {
    when: (facts) => facts.pr?.state !== "OPEN",
    refuse: (facts) =>
      refused("pr_not_open", `The PR is not open. Ask the person. ${unchanged}`, {
        next: {
          decider: "person",
          question: "How should the closed PR be handled before this review can continue?",
        },
        state: { prState: facts.pr?.state ?? null },
      }),
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
  const refusal =
    decideOwnership(facts) ?? roundRules.find((rule) => rule.when(facts))?.refuse(facts);
  if (refusal !== undefined) return refusal;
  if (facts.localHead === null)
    return refused("internal_review_head_missing", `The worktree has no commit. ${unchanged}`);
  return { result: "round", number: facts.review.rounds.length + 1, head: facts.localHead };
}

const commentEffect = { none: "post", stale: "update", current: "keep" } as const;

/**
 * The ready step posts the summary comment unless GitHub already holds it, and marks a draft
 * ready, so a retry after a lost answer repeats neither. A retry at a newer head or with other
 * rounds updates the earlier comment, so the one comment describes the PR that went ready.
 */
function ready(facts: ReadyFacts): Decision {
  return (
    decideOwnership(facts) ??
    readyRules.find((rule) => rule.when(facts))?.refuse(facts) ?? {
      result: "ready",
      head: facts.pr.head,
      comment: commentEffect[facts.posted],
      markReady: facts.pr.draft,
    }
  );
}

/** A skip ends the review with no comment, and marks a draft ready. */
function skip(facts: SkipFacts): Decision {
  const refusal = skipRules.find((rule) => rule.when(facts))?.refuse(facts);
  if (refusal !== undefined) return refusal;
  // Stryker disable next-line ConditionalExpression,StringLiteral: equivalent: the open PR rule already refused a PR that was not read
  if (facts.pr === null) return refused("pr_not_open", "");
  return { result: "skip", head: facts.pr.head, markReady: facts.pr.draft };
}

export function decideInternalReview(facts: Facts): Decision {
  if (facts.event === "associate") return associate(facts);
  if (facts.event === "ready") return ready(facts);
  if (facts.event === "skip") return skip(facts);
  return facts.event === "handoff" ? handoff(facts) : round(facts);
}
