import { Err, ErrAsync, Ok, OkAsync, fromPromise, type AsyncResult, type Result } from "unthrown";
import { z } from "zod";
// Bun has no file delete that ignores a missing file, which a retry after a crash can find.
import { rm } from "node:fs/promises";
import { DeviceState } from "../device-state/main.ts";
import {
  checkDraft,
  draftSchema,
  storedFindingsSchema,
  type AcceptedDraft,
  type Draft,
} from "./draft.ts";
import {
  postReview,
  readPullRequest,
  replyToThread,
  unresolveThread,
  type PostOutcome,
  type PullRequestFacts,
  type Target,
  type ThreadOutcome,
} from "./github.ts";
import {
  approvalBlocked,
  approvalWaits,
  blockerShorts,
  countBlockers,
  decideEvent,
  inlineComments,
  markerPrefix,
  renderReview,
  type HeadLimit,
  type ReviewEvent,
} from "./review-body.ts";
import { roundEffects } from "./slack-effects.ts";
import { decideReview, headMoveLimit } from "./review-machine.ts";
import {
  apply,
  files,
  openPullRequest,
  parseTarget,
  qualify,
  record,
  roundNumber,
  summary,
  type Failure,
  type Operation,
  type Outcome,
  type Paths,
  type Round,
  type Row,
  type Snapshot,
} from "./request.ts";
import { resolvedAfterPost } from "./rounds.ts";
import { failureOf, syncReviewer } from "./reviewer.ts";

type Posted = AsyncResult<Outcome, Failure>;

/** What a post reports about the accepted draft. A replayed post reports nothing. */
type Counts = Partial<{
  blockers: number;
  niceToHaves: number;
  headLimit: HeadLimit | null;
}>;

const draftJson = z.string().transform((value, context) => {
  try {
    // The draft schema parses this value next, in the same pipe.
    return JSON.parse(value) as unknown;
  } catch {
    context.addIssue("The draft is not JSON.");
    return z.NEVER;
  }
});

function readDraft(file: string) {
  return fromPromise(async () => {
    const handle = Bun.file(file);
    return (await handle.exists()) ? await handle.text() : null;
  }, qualify).flatMap((text): Result<Draft, Failure> => {
    if (text === null)
      return Err({
        reason: "review_draft_missing",
        detail: `Write the draft to ${file} before the post. Nothing was posted.`,
      });
    const parsed = draftJson.pipe(draftSchema).safeParse(text);
    return parsed.success
      ? Ok(parsed.data)
      : Err({
          reason: "review_draft_invalid",
          detail: `${z.prettifyError(parsed.error)}\nCorrect ${file}. Nothing was posted.`,
        });
  });
}

type Prepared = {
  request: Row;
  pr: PullRequestFacts;
  accepted: AcceptedDraft;
  event: ReviewEvent;
  headLimit: HeadLimit | null;
};

function approval(facts: Parameters<typeof decideEvent>[0], event: ReviewEvent) {
  // Stryker disable next-line ConditionalExpression: equivalent: decideEvent never computes an approval with an open blocker, so this guard only holds against a later rule change
  if (approvalBlocked(facts, event))
    // Stryker disable next-line ObjectLiteral: equivalent: decideEvent never computes an approval with an open blocker, so no post reaches this refusal
    return Err<Failure>({
      // Stryker disable next-line StringLiteral: equivalent: decideEvent never computes an approval with an open blocker, so no post reaches this refusal
      reason: "review_approval_blocked",
      // Stryker disable next-line StringLiteral: equivalent: decideEvent never computes an approval with an open blocker, so no post reaches this refusal
      detail: "A review with an open blocker cannot approve. Nothing was posted.",
    });
  if (approvalWaits(facts, event))
    return Err<Failure>({
      reason: "review_ci_pending",
      detail:
        "A required CI check still runs, or the PR has more checks than one read returns. Post the approval after CI finishes. Nothing was posted.",
    });
  return Ok(undefined);
}

/**
 * The commit that this round reviews. A draft of the live head posts. When the PR moved past the
 * reviewer's head, the reviewer gets the new head until the head-move limit, and after the limit
 * the round posts against the reviewer's head with the limit stated.
 */
export function chooseCommit(request: Row, draft: Draft, pr: PullRequestFacts) {
  const recorded = request.head;
  if (draft.reviewedCommit === pr.head || recorded === null || recorded === pr.head)
    return { kind: "post" as const, commit: pr.head, headLimit: null };
  if (request.state === "reviewing" && request.headMoves < headMoveLimit)
    return { kind: "move" as const, from: recorded, to: pr.head };
  if (request.headMoves >= headMoveLimit && draft.reviewedCommit === recorded)
    return {
      kind: "post" as const,
      commit: recorded,
      headLimit: {
        reviewedCommit: recorded,
        head: pr.head,
        moves: request.headMoves,
      },
    };
  return { kind: "post" as const, commit: pr.head, headLimit: null };
}

/** Records the head move and gives it to the reviewer. GitHub gets no post. */
function moveReviewer(paths: Paths, target: Target, from: string, to: string): Posted {
  return apply(paths, target, "head_moved", undefined, {
    observedFrom: from,
    to,
  })
    .toAsync()
    .flatMap(({ snapshot, transition }) =>
      (transition.sync === true
        ? syncReviewer(paths, target, snapshot)
        : OkAsync({ kind: null as string | null, mode: null as string | null })
      ).flatMap((synced): Posted =>
        ErrAsync<Failure>({
          reason: "review_head_moved",
          detail:
            transition.headMoved === true
              ? `PR #${target.number} moved from ${from} to ${to}${synced.mode === null ? "" : ` by a ${synced.mode}`}. ${synced.kind === "head" ? "The reviewer worktree moved, and the reviewer got the new commits." : "The reviewer must be replaced. Read operator review next."} Write a draft for ${to}. Nothing was posted.`
              : `PR #${target.number} moved to ${to}, and a wait gives it to the reviewer now. Write a draft for ${to}. Nothing was posted.`,
        }),
      ),
    );
}

/** Every refusal here happens before any write, and before GitHub sees a post. */
function prepare(paths: Paths, target: Target, request: Row) {
  return readDraft(files(paths, request).draft).flatMap((draft) =>
    openPullRequest(target).flatMap(
      (pr): AsyncResult<Prepared | { move: { from: string; to: string } }, Failure> => {
        const chosen = chooseCommit(request, draft, pr);
        if (chosen.kind === "move") return OkAsync({ move: chosen });
        return checkDraft(draft, pr, chosen.commit)
          .flatMap((accepted): Result<Prepared, Failure> => {
            const facts = {
              accepted,
              ownPullRequest: pr.author === pr.viewer,
              origin: request.origin,
            };
            const event = decideEvent(facts);
            return approval(facts, event).map(() => ({
              request,
              pr,
              accepted,
              event,
              headLimit: chosen.headLimit,
            }));
          })
          .toAsync();
      },
    ),
  );
}

function nextRound(request: Row, rounds: Round[], prepared: Prepared): Round {
  const number = roundNumber(rounds);
  const marker = `${markerPrefix}${request.id} round ${number} -->`;
  const { body } = renderReview({
    marker,
    event: prepared.event,
    accepted: prepared.accepted,
    requiredChecks: prepared.pr.requiredChecks.length,
    headLimit: prepared.headLimit,
  });
  return {
    requestId: request.id,
    number,
    trigger: request.trigger ?? "first",
    reviewedCommit: prepared.accepted.draft.reviewedCommit,
    draft: JSON.stringify(prepared.accepted.draft),
    event: prepared.event,
    body,
    marker,
    outcome: "pending",
    reviewId: null,
    reviewUrl: null,
    postedAt: null,
    warning: prepared.headLimit === null ? null : JSON.stringify(prepared.headLimit),
    blockers: JSON.stringify(blockerShorts(prepared.accepted)),
  };
}

/**
 * Each reply carries a marker, so a restart finds a lost reply instead of repeating it. An
 * explanation in a thread that the author resolved also reopens it, after the reply.
 */
export function plannedOperations(round: Round, draft: Draft, pr: PullRequestFacts): Operation[] {
  return draft.threadReplies.flatMap((reply) => {
    const marker = `${markerPrefix}${round.requestId} round ${round.number} thread ${reply.threadId} -->`;
    const base = {
      requestId: round.requestId,
      round: round.number,
      threadId: reply.threadId,
    };
    const resolved = pr.threads.some((thread) => thread.id === reply.threadId && thread.resolved);
    return [
      {
        ...base,
        kind: "reply",
        body: `${reply.body}\n\n${marker}`,
        marker,
        state: "pending",
        detail: null,
      },
      ...(reply.kind === "explain" && resolved
        ? [
            {
              ...base,
              kind: "unresolve",
              body: null,
              marker: null,
              state: "pending",
              detail: null,
            },
          ]
        : []),
    ];
  });
}

function summarize(operations: Operation[]) {
  return operations.map((operation) => ({
    threadId: operation.threadId,
    kind: operation.kind,
    state: operation.state,
    detail: operation.detail,
  }));
}

/**
 * Runs the round's pending thread operations in order and records each outcome at once. A lost
 * answer stops the run, and the retry reads the threads before it writes again.
 */
function runOperations(paths: Paths, target: Target, request: Row, operations: Operation[]) {
  return fromPromise(() => operationsInOrder(paths, target, request, operations), qualify).flatMap(
    (result) => result,
  );
}

async function operationsInOrder(
  paths: Paths,
  target: Target,
  request: Row,
  operations: Operation[],
) {
  const done: Operation[] = [];
  for (const operation of operations) {
    if (operation.state !== "pending") {
      done.push(operation);
      continue;
    }
    // Only a reply carries a body, and an unresolve carries none.
    const answered = await (operation.body !== null
      ? replyToThread(operation.threadId, operation.body)
      : unresolveThread(operation.threadId));
    const outcome: ThreadOutcome =
      answered.tag === "Ok"
        ? answered.value
        : { status: "uncertain", detail: "The write stopped." };
    if (outcome.status === "uncertain")
      return Err<Failure>({
        reason: "github_uncertain",
        detail: `GitHub did not confirm the ${operation.kind} in thread ${operation.threadId}: ${outcome.detail} Run the post again. It reads the thread first, so it does not reply twice.`,
      });
    const recorded: Operation = {
      ...operation,
      state: outcome.status === "done" ? "done" : "failed",
      detail: outcome.status === "failed" ? outcome.detail : null,
    };
    const written = record(paths, target, request.id, {
      operations: [recorded],
    });
    if (written.tag !== "Ok") return Err(failureOf(written));
    done.push(recorded);
  }
  return Ok(done);
}

/** A retry marks each operation that GitHub already holds, from one read of the threads. */
export function reconcile(operations: Operation[], pr: PullRequestFacts): Operation[] {
  return operations.map((operation) => {
    if (operation.state !== "pending") return operation;
    const thread = pr.threads.find((row) => row.id === operation.threadId);
    if (thread === undefined) return operation;
    const landed =
      operation.kind === "reply"
        ? // Stryker disable next-line StringLiteral: equivalent: a reply operation always has its marker
          thread.comments.some((comment) => comment.body.includes(operation.marker ?? "\0"))
        : !thread.resolved;
    return landed ? { ...operation, state: "done" } : operation;
  });
}

/** Ends the round after GitHub holds the review and every thread operation finished. */
function complete(
  paths: Paths,
  target: Target,
  round: Round,
  pr: PullRequestFacts,
  operations: Operation[],
  counts: Counts,
): Posted {
  const reopened = operations
    .filter((operation) => operation.kind === "unresolve" && operation.state === "done")
    .map((operation) => operation.threadId);
  return apply(
    paths,
    target,
    "posted",
    (_transition, current) => ({
      update: {
        failureReason: null,
        failureDetail: null,
        trigger: null,
        headMoves: 0,
        resolvedThreads: JSON.stringify(resolvedAfterPost(pr, reopened)),
      },
      operations,
      // The same write ends the round and records its Slack effects, so a crash loses neither.
      effects: roundEffects(current.rounds, round, target.url),
    }),
    { event: round.event },
  )
    .toAsync()
    .flatMap(({ snapshot }) =>
      // The round row keeps the posted draft. A new round must not post the same file again.
      fromPromise(
        () =>
          rm(files(paths, { repository: target.repository, id: round.requestId }).draft, {
            force: true,
          }),
        qualify,
      ).map(() => snapshot),
    )
    .map((snapshot) => ({
      reason: "review_posted",
      data: {
        ...summary(paths, snapshot),
        event: round.event,
        threadOperations: summarize(operations),
        ...counts,
      },
    }));
}

function uncertain(paths: Paths, target: Target, error: Failure): Posted {
  return apply(paths, target, "post_uncertain")
    .toAsync()
    .flatMap(() => ErrAsync<Failure>(error));
}

/** Records the review that GitHub holds, or the failure. Every recorded event is GitHub's. */
function finish(
  paths: Paths,
  target: Target,
  request: Row,
  round: Round,
  outcome: PostOutcome,
  next: (posted: Round) => Posted,
): Posted {
  if (outcome.status === "posted") {
    const posted: Round = {
      ...round,
      event: outcome.review.event,
      outcome: "posted",
      reviewId: outcome.review.id,
      reviewUrl: outcome.review.url,
      postedAt: new Date().toISOString(),
    };
    return record(paths, target, request.id, { round: posted })
      .toAsync()
      .flatMap(() => next(posted));
  }
  const failed = outcome.status === "failed";
  return apply(paths, target, failed ? "post_failed" : "post_uncertain", () => ({
    update: failed ? { failureReason: "review_post_failed", failureDetail: outcome.detail } : {},
    round: { ...round, outcome: failed ? "failed" : "uncertain" },
  }))
    .toAsync()
    .flatMap(() =>
      ErrAsync<Failure>(
        failed
          ? {
              reason: "review_post_failed",
              detail: `GitHub refused the review: ${outcome.detail} Correct the draft and post again.`,
            }
          : {
              reason: "github_uncertain",
              detail: `GitHub did not confirm the review: ${outcome.detail} Run the post again. It first looks for this review, so it does not post twice.`,
            },
      ),
    );
}

/** The lease shows that this post still runs. A killed post becomes a retry in next. */
function holding(paths: Paths, id: string, work: () => Posted): Posted {
  return fromPromise(() => {
    const release = DeviceState.holdReviewRequest(paths, id);
    return Promise.resolve(work()).finally(release);
  }, qualify).flatMap((result) => result);
}

function send(target: Target, round: Round, comments: ReturnType<typeof inlineComments>) {
  return postReview(target, {
    commit: round.reviewedCommit,
    event: round.event,
    body: round.body,
    comments,
  });
}

/**
 * Gives up a post that another process changed between the read and the write. The write took
 * the lease, so the next post decides again at once. No other process takes the fresh lease of
 * this running process before this release.
 */
function yieldPost(paths: Paths, target: Target, request: Row): Posted {
  return DeviceState.changeReviewRequest(paths, { ...target, id: request.id }, () =>
    Ok({ lease: "release" as const }),
  )
    .toAsync()
    .flatMap(() =>
      ErrAsync<Failure>({
        reason: "review_post_in_progress",
        detail: "Another process started this post. Run the post again. Nothing was posted.",
      }),
    );
}

/** A first post of the current draft. */
function freshPost(paths: Paths, target: Target, request: Row): Posted {
  return prepare(paths, target, request).flatMap((prepared): Posted => {
    if ("move" in prepared)
      return moveReviewer(paths, target, prepared.move.from, prepared.move.to);
    let planned: { round: Round; operations: Operation[] } | null = null;
    return apply(paths, target, "post", (_transition, current) => {
      const round = nextRound(prepared.request, current.rounds, prepared);
      planned = {
        round,
        operations: plannedOperations(round, prepared.accepted.draft, prepared.pr),
      };
      return planned;
    })
      .toAsync()
      .flatMap(({ transition }): Posted => {
        // A concurrent process can turn this post into a retry between the read and the write.
        if (
          transition.retry === true ||
          // Stryker disable next-line ConditionalExpression: equivalent: the payload runs for every decided post, so a decided post always has its plan
          planned === null
        )
          return yieldPost(paths, target, request);
        const counts = {
          blockers: countBlockers(prepared.accepted),
          niceToHaves: prepared.accepted.draft.niceToHaves.length,
          headLimit: prepared.headLimit,
        };
        const comments = inlineComments(prepared.accepted.draft);
        const { round, operations } = planned;
        return holding(paths, request.id, () =>
          send(target, round, comments).flatMap((outcome) =>
            finish(paths, target, request, round, outcome, (posted) =>
              threads(paths, target, request, posted, prepared.pr, operations, counts),
            ),
          ),
        );
      });
  });
}

/** Runs the thread operations of a round that GitHub holds, then ends the round. */
function threads(
  paths: Paths,
  target: Target,
  request: Row,
  round: Round,
  pr: PullRequestFacts,
  operations: Operation[],
  counts: Counts,
): Posted {
  return fromPromise(
    async () => await runOperations(paths, target, request, operations),
    qualify,
  ).flatMap((result): Posted => {
    if (result.tag === "Ok") return complete(paths, target, round, pr, result.value, counts);
    // The request stays posting, so next offers the retry that reads the threads first.
    return uncertain(paths, target, failureOf(result));
  });
}

/**
 * A retry after a post or a thread operation lost its answer. It ignores the current draft and
 * finishes the recorded round: GitHub may hold its review and replies, so it reads them first.
 */
function retryPost(paths: Paths, target: Target, request: Row, snapshot: Snapshot): Posted {
  const round = snapshot.rounds.at(-1);
  if (round === undefined)
    return ErrAsync({
      reason: "review_defect",
      detail: "The retry lost its round.",
    });
  return apply(paths, target, "post")
    .toAsync()
    .flatMap(({ transition }) =>
      // A concurrent process can end the retry between the read and the write.
      transition.retry !== true
        ? yieldPost(paths, target, request)
        : holding(paths, request.id, () =>
            readPullRequest(target).flatMap((pr): Posted => {
              const operations = reconcile(snapshot.operations, pr);
              const owner: Row = request;
              function next(posted: Round) {
                return threads(paths, target, owner, posted, pr, operations, {});
              }
              if (round.outcome === "posted") return next(round);
              const found = pr.reviews.find(
                (review) => review.byViewer && review.body.includes(round.marker),
              );
              if (found !== undefined)
                return finish(
                  paths,
                  target,
                  request,
                  round,
                  {
                    status: "posted",
                    review: {
                      id: found.id,
                      url: found.url,
                      event: found.event,
                    },
                  },
                  next,
                );
              if (pr.state !== "OPEN" || pr.head !== round.reviewedCommit)
                // No stale post: the request returns to its reviewer for a draft of the new head.
                return apply(paths, target, "post_failed", () => ({
                  update: {
                    failureReason: "review_head_moved",
                    failureDetail: "The PR changed after a lost post.",
                  },
                  round: { ...round, outcome: "failed" },
                }))
                  .toAsync()
                  .flatMap(() =>
                    ErrAsync<Failure>({
                      reason: "review_head_moved",
                      detail: `GitHub has no review from the lost post, and PR #${target.number} is no longer open at ${round.reviewedCommit}. Write a new draft for the current head. Nothing was posted.`,
                    }),
                  );
              const findings = storedFindingsSchema.parse(JSON.parse(round.draft));
              return send(target, round, inlineComments(findings)).flatMap((outcome) =>
                finish(paths, target, request, round, outcome, next),
              );
            }),
          ),
    );
}

// Stryker disable next-line ObjectLiteral,StringLiteral: equivalent: the machine refuses a post of a missing request, so no post reaches this failure
const lostRequest: Failure = {
  reason: "review_defect",
  detail: "The post lost its request.",
};

/**
 * The one review write path. It checks the draft, the live PR head, and required CI, computes
 * the event, posts once, and runs the thread replies. A post or a reply that lost its answer is
 * found by its marker, not repeated.
 */
export function post(input: { paths: Paths; url: string }) {
  return parseTarget(input.url)
    .toAsync()
    .flatMap((target) =>
      DeviceState.readReviewRequest(input.paths, target)
        .toAsync()
        .flatMap((snapshot): Posted => {
          const decided = decideReview({
            command: "post",
            registered: snapshot.project !== null,
            request: snapshot.request,
            ownerActive: snapshot.ownerActive,
          });
          if (decided.tag !== "Ok") return ErrAsync(failureOf(decided));
          const request = snapshot.request;
          // Stryker disable next-line ConditionalExpression: equivalent: the machine refuses a post of a missing request
          if (request === null) return ErrAsync(lostRequest);
          return decided.value.retry === true
            ? retryPost(input.paths, target, request, snapshot)
            : freshPost(input.paths, target, request);
        }),
    );
}
