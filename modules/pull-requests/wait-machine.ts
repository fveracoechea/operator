import { z } from "zod";
import type { FeedbackItem, Check, Observation } from "./github.ts";

/** What earlier waits already reported. A restarted wait continues from this record. */
export const progressSchema = z.object({
  seen: z.array(z.string()),
  failures: z.array(z.string()),
  eligibleHead: z.string().nullable(),
});
export type Progress = z.infer<typeof progressSchema>;

export type MergeConditions = {
  approved: boolean;
  checksPassing: boolean;
  threadsResolved: boolean;
  defaultBase: boolean;
  /** A stacked PR's parent merged and the relay finished, so no parent commit rides along. */
  stackRelayed: boolean;
};
export type WaitEvent =
  | { kind: "feedback"; items: FeedbackItem[] }
  | { kind: "checks_failed"; head: string; checks: Check[] }
  | { kind: "merge_eligible"; head: string }
  | { kind: "pr_merged" | "pr_closed" };
// A PR without a stack parent has nothing to relay.
type Facts = { progress: Progress; observed: Observation; stackRelayed?: boolean };
type Decision =
  | { result: "not_open"; events: WaitEvent[]; progress: Progress }
  | { result: "reported"; events: WaitEvent[]; progress: Progress }
  | { result: "none" };

/** The five conditions that the later merge gate checks again before it merges. */
export function mergeConditions(observed: Observation, stackRelayed = true): MergeConditions {
  return {
    approved: observed.approved,
    // Just after a push GitHub can report no checks yet, so no checks is not passing checks.
    checksPassing:
      observed.checksComplete &&
      observed.checks.length > 0 &&
      observed.checks.every((check) => check.state === "passing"),
    threadsResolved: observed.unresolvedThreads === 0,
    // A repository without a default branch reports null, which no base name equals.
    defaultBase: observed.base === observed.defaultBranch,
    stackRelayed,
  };
}

function eligible({ observed, stackRelayed }: Facts) {
  return Object.values(mergeConditions(observed, stackRelayed)).every(Boolean);
}

// A review with no body and no verdict only holds inline comments, which are reported themselves.
function unseenFeedback({ progress, observed }: Facts) {
  return observed.feedback.filter(
    (item) =>
      !progress.seen.includes(item.id) &&
      // Only a review carries a review state, so this keeps every comment.
      (item.body.trim() !== "" || item.reviewState !== "COMMENTED"),
  );
}

function unseenFailures({ progress, observed }: Facts) {
  return observed.checks.filter(
    (check) =>
      check.state === "failing" && !progress.failures.includes(`${observed.head}:${check.name}`),
  );
}

function newlyEligible({ progress, observed, stackRelayed }: Facts) {
  return eligible({ progress, observed, stackRelayed }) && progress.eligibleHead !== observed.head;
}

function report(facts: Facts): Decision {
  const { progress, observed } = facts;
  const items = unseenFeedback(facts);
  const failing = unseenFailures(facts);
  const events: WaitEvent[] = [];
  if (items.length > 0) events.push({ kind: "feedback", items });
  if (failing.length > 0)
    events.push({ kind: "checks_failed", head: observed.head, checks: failing });
  if (newlyEligible(facts)) events.push({ kind: "merge_eligible", head: observed.head });
  return {
    result: "reported",
    events,
    progress: {
      seen: [...progress.seen, ...items.map((item) => item.id)],
      failures: [...progress.failures, ...failing.map((check) => `${observed.head}:${check.name}`)],
      eligibleHead: eligible(facts) ? observed.head : progress.eligibleHead,
    },
  };
}

const rules: { when: (facts: Facts) => boolean; decide: (facts: Facts) => Decision }[] = [
  {
    when: ({ observed }) => observed.state !== "OPEN",
    decide: ({ progress, observed }) => ({
      result: "not_open",
      events: [{ kind: observed.state === "MERGED" ? "pr_merged" : "pr_closed" }],
      progress,
    }),
  },
  {
    // The owner's own replies are reported with the next real event, never alone. An
    // assignment reviewer posts with the owner's account, and its review is a real event.
    when: (facts) =>
      unseenFeedback(facts).some((item) => !item.fromViewer || item.operatorReview) ||
      unseenFailures(facts).length > 0 ||
      newlyEligible(facts),
    decide: report,
  },
];

/**
 * Decides what one observation adds to the recorded progress. Each item, failing check on a
 * head, and eligible head is reported once, so a repeated or restarted wait does not repeat it.
 */
export function decideWait(facts: Facts): Decision {
  return rules.find((rule) => rule.when(facts))?.decide(facts) ?? { result: "none" };
}
