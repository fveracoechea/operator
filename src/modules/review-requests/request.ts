import { isCodedError } from "../../lib/coded-error.ts";
import { Err, Ok, type OkOf, type Result } from "unthrown";
import { z } from "zod";
import { DeviceState } from "../device-state/main.ts";
import { OperatorHome } from "../operator-home/main.ts";
import {
  pullRequestTarget,
  readPullRequest,
  type PullRequestFacts,
  type Target,
} from "./github.ts";
import {
  decideReview,
  type ReviewCommand,
  type ReviewFacts,
  type ReviewTransition,
} from "./review-machine.ts";
import { headLimitSchema } from "./review-body.ts";

export type Paths = ReturnType<typeof OperatorHome.resolve>;
export type Failure = { reason: string; detail: string };
export type Snapshot = OkOf<ReturnType<typeof DeviceState.readReviewRequest>>;
export type Row = NonNullable<Snapshot["request"]>;
export type Round = Snapshot["rounds"][number];
export type Operation = Snapshot["operations"][number];
type Payload = {
  insert?: Pick<Row, "id" | "repository" | "number" | "url" | "origin" | "state">;
  update?: Partial<Omit<Row, "id">>;
  round?: Round;
  operations?: Operation[];
  /** Slack effects, recorded only for a request with a Slack thread. */
  effects?: { key: string; kind: string; content: string }[];
};
/** A move or a prompt that a decided transition gives to the running reviewer. */
const syncSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("round"), round: z.number().int(), trigger: z.string() }),
  // A round on a moved PR moves the worktree like a head move, and names its round.
  z.object({
    kind: z.literal("head"),
    from: z.string(),
    to: z.string(),
    round: z.number().int().optional(),
    trigger: z.string().optional(),
  }),
]);
export type Sync = z.infer<typeof syncSchema>;
export type Outcome = { reason: string; data: object };

/** A thrown file-system failure is an I/O failure. Any other cause is a defect. */
export function qualify<C, T>(cause: C, defect: (cause: C) => T) {
  if (
    isCodedError(cause) &&
    ["ENOENT", "EACCES", "EPERM", "EIO", "EROFS", "ENOSPC", "ENOTDIR", "EISDIR"].includes(
      cause.code,
    )
  )
    return { reason: "review_io_failed", detail: String(cause) };
  return defect(cause);
}

export function parseTarget(url: string): Result<Target, Failure> {
  const target = pullRequestTarget(url);
  return target === null
    ? Err({
        reason: "review_url_invalid",
        detail: `Give a GitHub pull request URL, such as https://github.com/owner/repository/pull/7, not ${url}.`,
      })
    : Ok(target);
}

export function openPullRequest(target: Target) {
  return readPullRequest(target).flatMap((pr): Result<PullRequestFacts, Failure> =>
    pr.state === "OPEN"
      ? Ok(pr)
      : Err({
          reason: "review_pr_not_open",
          detail: `PR #${target.number} is ${pr.state.toLowerCase()}, so it gets no review. Nothing changed.`,
        }),
  );
}

/** The number of the round that the next post records. A failed post keeps its number. */
export function roundNumber(rounds: Round[]) {
  const last = rounds.at(-1);
  if (last === undefined) return 1;
  return last.outcome === "posted" ? last.number + 1 : last.number;
}

export function parseSync(text: string | null): Sync | null {
  return text === null ? null : syncSchema.parse(JSON.parse(text));
}

/** The head that a round moves the reviewer to, when the PR moved since the reviewer's head. */
function roundHead(request: Row, facts: Extra) {
  const from = request.head;
  return from !== null && facts.to !== undefined && facts.to !== from
    ? { from, to: facts.to }
    : null;
}

/** A round on a moved PR moves the worktree first. Other rounds only prompt. */
function roundSync(trigger: string, request: Row, rounds: Round[], facts: Extra): Sync {
  const round = roundNumber(rounds);
  const moved = roundHead(request, facts);
  return moved === null
    ? { kind: "round", round, trigger }
    : { kind: "head", ...moved, round, trigger };
}

/** A round restarts the head-move count and the activity clock, and clears the stale flag. */
function roundUpdate(
  trigger: string,
  sync: boolean,
  current: { request: Row; rounds: Round[] },
  facts: Extra,
  now: string,
) {
  return {
    trigger,
    headMoves: 0,
    activityAt: now,
    staleAt: null,
    sync: sync ? JSON.stringify(roundSync(trigger, current.request, current.rounds, facts)) : null,
    head: roundHead(current.request, facts)?.to ?? current.request.head,
  };
}

function headMoveUpdate(transition: ReviewTransition, request: Row, from: string, to: string) {
  return {
    head: to,
    headMoves: request.headMoves + 1,
    sync:
      transition.sync === true ? JSON.stringify({ kind: "head", from, to } satisfies Sync) : null,
  };
}

/** The recorded fields that a decided transition sets on a recorded request. */
function transitionUpdate(
  transition: ReviewTransition,
  current: { request: Row; rounds: Round[] },
  facts: Extra,
): Partial<Omit<Row, "id">> {
  const now = new Date().toISOString();
  const update: Partial<Omit<Row, "id">> = {};
  if (transition.state !== undefined) update.state = transition.state;
  if (transition.launchState !== undefined) update.launchState = transition.launchState;
  if (transition.ended === true) update.endedAt = now;
  if (transition.cleanup === true) update.cleanupState = "pending";
  if (transition.round !== undefined)
    Object.assign(
      update,
      roundUpdate(transition.round, transition.sync === true, current, facts, now),
    );
  const observed = facts.observedFrom;
  if (
    transition.headMoved === true &&
    facts.to !== undefined &&
    // Stryker disable next-line ConditionalExpression: equivalent: a head move is decided only when the observed head equals the recorded head, so it always has an observed head
    observed !== undefined
  )
    Object.assign(update, headMoveUpdate(transition, current.request, observed, facts.to));
  return update;
}

type Extra = Pick<ReviewFacts, "event" | "trigger" | "observedFrom"> & {
  /** The id of the request to change, for an ended request or an exact target. */
  id?: string;
  /** For `head_moved` and a round, the live head. */
  to?: string;
};

/**
 * Applies one decided transition in a write transaction. The decision and the recorded
 * resources read the request there, so two commands never act on the same state.
 */
export function apply(
  paths: Paths,
  target: Target,
  command: ReviewCommand,
  payload: (transition: ReviewTransition, current: Snapshot) => Payload = () => ({}),
  extra: Extra = {},
) {
  let decided: ReviewTransition = {};
  return DeviceState.changeReviewRequest(paths, { ...target, id: extra.id }, (current) =>
    decideReview({
      command,
      registered: current.project !== null,
      request: current.request,
      ownerActive: current.ownerActive,
      event: extra.event,
      trigger: extra.trigger,
      observedFrom: extra.observedFrom,
      ownLease: current.request?.ownerPid === process.pid,
    }).map((transition) => {
      decided = transition;
      const added = payload(transition, current);
      const request = current.request;
      return {
        insert: transition.insert === true ? added.insert : undefined,
        // A new request is inserted with its identity alone.
        update:
          // Stryker disable next-line ConditionalExpression: equivalent: a change ignores the update of an inserted request, and only a round or a head move reads the request
          request === null
            ? added.update
            : {
                ...added.update,
                ...transitionUpdate(transition, { request, rounds: current.rounds }, extra),
              },
        round: added.round,
        operations: added.operations,
        effects: added.effects,
        lease: transition.lease,
      };
    }),
  ).map((snapshot) => ({ snapshot, transition: decided }));
}

/** Records a change that is not a transition, only while this process holds the request. */
export function record(paths: Paths, target: Target, id: string, change: Payload) {
  return DeviceState.changeReviewRequest(paths, { ...target, id }, (current) =>
    current.request?.ownerPid === process.pid
      ? Ok({ update: change.update, round: change.round, operations: change.operations })
      : Err<Failure>({
          reason: "review_lease_lost",
          detail: "Another process took this review request. Nothing more was recorded.",
        }),
  );
}

export function files(paths: Paths, request: Pick<Row, "repository" | "id">) {
  return OperatorHome.reviewFiles(paths, { repository: request.repository, requestId: request.id });
}

export function latestPosted(rounds: Round[]) {
  return rounds.findLast((round) => round.outcome === "posted") ?? null;
}

/** The caller-facing view of one request. */
export function summary(paths: Paths, snapshot: Pick<Snapshot, "request" | "rounds">) {
  const request = snapshot.request;
  if (request === null) return null;
  const posted = latestPosted(snapshot.rounds);
  const located = files(paths, request);
  return {
    id: request.id,
    url: request.url,
    repository: request.repository,
    number: request.number,
    origin: request.origin,
    assignment:
      request.origin === "assignment"
        ? { sourceId: request.sourceId, assignment: request.assignment }
        : null,
    state: request.state,
    head: request.head,
    round: {
      number: ["watching", "approved"].includes(request.state)
        ? (posted?.number ?? 0)
        : roundNumber(snapshot.rounds),
      trigger: request.trigger ?? (posted === null ? "first" : null),
      headMoves: request.headMoves,
    },
    stale: request.staleAt !== null,
    reviewer:
      request.launchState === null
        ? null
        : {
            state: request.launchState,
            name: request.name,
            branch: request.branch,
            paneId: request.paneId,
            worktreePath: request.worktreePath,
            failure:
              request.failureReason === null
                ? null
                : { reason: request.failureReason, detail: request.failureDetail },
          },
    cleanup:
      request.cleanupState === null
        ? null
        : { state: request.cleanupState, detail: request.cleanupDetail },
    brief: located.brief,
    draft: located.draft,
    review:
      posted === null
        ? null
        : {
            round: posted.number,
            event: posted.event,
            url: posted.reviewUrl,
            commit: posted.reviewedCommit,
            headLimit:
              posted.warning === null ? null : headLimitSchema.parse(JSON.parse(posted.warning)),
          },
  };
}
