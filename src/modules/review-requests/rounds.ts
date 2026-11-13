import type { PullRequestFacts } from "./github.ts";
import type { RoundTrigger } from "./review-machine.ts";

/** A request in `watching` with no author activity for this long gets the stale flag. */
export const staleAfterMs = 7 * 24 * 60 * 60 * 1000;

export type WatchFacts = {
  state: string;
  /** The head that the reviewer has. */
  head: string | null;
  /** The start of the current round. Author activity after it starts the next round. */
  since: string;
  /** The last post, which also restarts the stale clock. */
  postedAt: string | null;
  /** The posting account's resolved threads when the last round posted. */
  resolvedThreads: string[];
  staleAt: string | null;
  pr: PullRequestFacts;
  now: number;
};
export type WatchDecision =
  | { kind: "close" }
  | { kind: "round"; trigger: RoundTrigger; head: string }
  | { kind: "head_moved"; from: string; to: string }
  | { kind: "stale" }
  | { kind: "none" };

function after(time: string, since: string) {
  return Date.parse(time) > Date.parse(since);
}

/**
 * Author activity after the round start: a reply in a review thread of the posting account, or
 * a conversation comment that mentions the posting account. Other comments start no round.
 */
function replied({ pr, since }: WatchFacts) {
  if (pr.author === null || pr.author === pr.viewer) return false;
  const threadReply = pr.threads.some(
    (thread) =>
      thread.startedByViewer &&
      thread.comments.some(
        (comment) => comment.author === pr.author && after(comment.createdAt, since),
      ),
  );
  const mention = new RegExp(`@${pr.viewer.replaceAll(/[^A-Za-z0-9-]/g, "")}(?![A-Za-z0-9-])`, "i");
  return (
    threadReply ||
    pr.comments.some(
      (comment) =>
        comment.author === pr.author &&
        after(comment.createdAt, since) &&
        mention.test(comment.body),
    )
  );
}

/** A thread of the posting account that someone else resolved since the last post. */
function resolved({ pr, resolvedThreads }: WatchFacts) {
  return pr.threads.some(
    (thread) =>
      thread.startedByViewer &&
      thread.resolved &&
      thread.resolvedBy !== pr.viewer &&
      !resolvedThreads.includes(thread.id),
  );
}

/** GitHub answers a review request with any later review, so only a request after the last post counts. */
function rerequested({ pr, since, postedAt }: WatchFacts) {
  const answered = new Date(
    Math.max(Date.parse(since), Date.parse(postedAt ?? since)),
  ).toISOString();
  return pr.reviewRequests.some(
    (request) => request.reviewer === pr.viewer && after(request.createdAt, answered),
  );
}

/** The round triggers in their reporting order. The first that holds names the round. */
const triggers: [RoundTrigger, (facts: WatchFacts) => boolean][] = [
  ["commits", (facts) => facts.head !== null && facts.pr.head !== facts.head],
  ["reply", replied],
  ["resolved", resolved],
  ["re-request", rerequested],
];

/**
 * What one PR read means for one request, from the recorded request and the read alone. An
 * approved request reopens only for a renewed request, and only a watching request goes stale.
 */
export function decideWatch(facts: WatchFacts): WatchDecision {
  if (facts.pr.state !== "OPEN") return { kind: "close" };
  // The machine owns the head-move limit, so a move past it changes nothing.
  if (facts.state === "reviewing")
    return facts.head !== null && facts.pr.head !== facts.head
      ? { kind: "head_moved", from: facts.head, to: facts.pr.head }
      : { kind: "none" };
  if (facts.state === "approved")
    return rerequested(facts)
      ? { kind: "round", trigger: "re-request", head: facts.pr.head }
      : { kind: "none" };
  if (facts.state !== "watching") return { kind: "none" };
  const trigger = triggers.find(([, holds]) => holds(facts));
  if (trigger !== undefined) return { kind: "round", trigger: trigger[0], head: facts.pr.head };
  const quietSince = Math.max(Date.parse(facts.since), Date.parse(facts.postedAt ?? facts.since));
  return facts.staleAt === null && facts.now - quietSince >= staleAfterMs
    ? { kind: "stale" }
    : { kind: "none" };
}

/** The posting account's threads that are resolved after this round's own thread operations. */
export function resolvedAfterPost(pr: PullRequestFacts, reopened: string[]) {
  return pr.threads
    .filter((thread) => thread.startedByViewer && thread.resolved && !reopened.includes(thread.id))
    .map((thread) => thread.id);
}
