import { Err, ErrAsync, Ok, fromPromise, type AsyncResult, type Result } from "unthrown";
import { z } from "zod";
import { DeviceState } from "../device-state/main.ts";
import { OperatorHome } from "../operator-home/main.ts";
import { WorkerDispatch } from "../worker-dispatch/main.ts";
import { renderReviewerBrief } from "./brief.ts";
import { checkDraft, draftSchema, type AcceptedDraft, type Draft } from "./draft.ts";
import {
  postReview,
  pullRequestTarget,
  readPullRequest,
  type PostOutcome,
  type PullRequestFacts,
  type Target,
} from "./github.ts";
import {
  approvalBlocked,
  approvalWaits,
  decideEvent,
  inlineComments,
  renderReview,
  type ReviewEvent,
} from "./review-body.ts";
import {
  decideReview,
  reviewAction,
  type ReviewCommand,
  type ReviewTransition,
} from "./review-machine.ts";

type Paths = ReturnType<typeof OperatorHome.resolve>;
type Failure = { reason: string; detail: string };
type OkOf<R> = R extends { tag: "Ok"; value: infer V } ? V : never;
type Snapshot = OkOf<ReturnType<typeof DeviceState.readReviewRequest>>;
type Row = NonNullable<Snapshot["request"]>;
type Round = Snapshot["rounds"][number];
type Payload = {
  insert?: Pick<Row, "id" | "repository" | "number" | "url" | "origin" | "state">;
  update?: Partial<Omit<Row, "id">>;
  round?: Round;
};

function qualify<T>(cause: unknown, defect: (cause: unknown) => T) {
  if (
    cause instanceof Error &&
    "code" in cause &&
    ["ENOENT", "EACCES", "EPERM", "EIO", "EROFS", "ENOSPC", "ENOTDIR", "EISDIR"].includes(
      String(cause.code),
    )
  )
    return { reason: "review_io_failed", detail: String(cause) };
  return defect(cause);
}

function parseTarget(url: string): Result<Target, Failure> {
  const target = pullRequestTarget(url);
  return target === null
    ? Err({
        reason: "review_url_invalid",
        detail: `Give a GitHub pull request URL, such as https://github.com/owner/repository/pull/7, not ${url}.`,
      })
    : Ok(target);
}

function openPullRequest(target: Target) {
  return readPullRequest(target).flatMap((pr): Result<PullRequestFacts, Failure> =>
    pr.state === "OPEN"
      ? Ok(pr)
      : Err({
          reason: "review_pr_not_open",
          detail: `PR #${target.number} is ${pr.state.toLowerCase()}, so it gets no review. Nothing changed.`,
        }),
  );
}

/**
 * Applies one decided transition in a write transaction. The decision and the recorded
 * resources read the request there, so two commands never act on the same state.
 */
function apply(
  paths: Paths,
  target: Target,
  command: ReviewCommand,
  payload: (transition: ReviewTransition, current: Snapshot) => Payload,
  event?: ReviewEvent,
) {
  const seen: { transition: ReviewTransition } = { transition: {} };
  return DeviceState.changeReviewRequest(paths, target, (current) =>
    decideReview({
      command,
      registered: current.project !== null,
      request: current.request,
      ownerActive: current.ownerActive,
      event,
    }).map((transition) => {
      seen.transition = transition;
      const extra = payload(transition, current);
      const update: Partial<Omit<Row, "id">> = { ...extra.update };
      if (transition.state !== undefined) update.state = transition.state;
      if (transition.launchState !== undefined) update.launchState = transition.launchState;
      if (transition.ended === true) update.endedAt = new Date().toISOString();
      return {
        insert: transition.insert === true ? extra.insert : undefined,
        update,
        round: extra.round,
        lease: transition.lease,
      };
    }),
  ).map((snapshot) => ({ snapshot, transition: seen.transition }));
}

function files(paths: Paths, request: Row) {
  return OperatorHome.reviewFiles(paths, { repository: request.repository, requestId: request.id });
}

function latestPosted(rounds: Round[]) {
  return rounds.findLast((round) => round.outcome === "posted") ?? null;
}

function summary(paths: Paths, snapshot: Snapshot) {
  const request = snapshot.request;
  if (request === null) return null;
  const posted = latestPosted(snapshot.rounds);
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
    ...files(paths, request),
    review:
      posted === null
        ? null
        : {
            round: posted.number,
            event: posted.event,
            url: posted.reviewUrl,
            commit: posted.reviewedCommit,
          },
  };
}

/** Records a manual request. It uses the Slack-origin contract, and it needs no Slack transport. */
function add(input: { paths: Paths; url: string }) {
  return parseTarget(input.url)
    .toAsync()
    .flatMap((target) =>
      openPullRequest(target).flatMap(() =>
        apply(input.paths, target, "add", () => ({
          insert: {
            id: crypto.randomUUID(),
            repository: target.repository,
            number: target.number,
            url: target.url,
            origin: "slack",
            state: "queued",
          },
        })).map(({ snapshot, transition }) => ({
          reason: transition.unchanged === true ? "review_unchanged" : "review_queued",
          data: summary(input.paths, snapshot),
        })),
      ),
    );
}

function slug(text: string) {
  return text
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, "-")
    .replaceAll(/^-+|-+$/g, "");
}

/** Records each resource of a start that this process still owns. */
function recordLaunch(paths: Paths, target: Target, id: string) {
  return (change: Partial<Omit<Row, "id">>) =>
    DeviceState.changeReviewRequest(paths, target, (current) =>
      current.request?.id === id && current.request.launchState === "starting"
        ? Ok({ update: change })
        : Err({
            reason: "review_start_interrupted",
            detail: "The reviewer start is no longer recorded as this process's start.",
          }),
    );
}

function launch(input: { paths: Paths; profile?: string }, target: Target, snapshot: Snapshot) {
  const request = snapshot.request;
  const project = snapshot.project;
  if (request === null || project === null || request.head === null)
    return ErrAsync<Failure>({ reason: "review_defect", detail: "The start lost its request." });
  const name = slug(target.repository.split("/").at(-1) ?? "");
  const paths = files(input.paths, request);
  const head = request.head;
  return WorkerDispatch.launchReviewer({
    paths: input.paths,
    checkout: project.checkout,
    repository: target.repository,
    number: target.number,
    head,
    nameBase: `${name}-pr${target.number}-review`.slice(0, 28).replace(/-+$/, ""),
    branchBase: `review/${name}-pr-${target.number}`,
    profile: input.profile,
    reuse:
      request.worktreePath === null || request.branch === null
        ? null
        : { path: request.worktreePath, branch: request.branch },
    brief: {
      file: paths.brief,
      render: ({ worktree, branch }) =>
        renderReviewerBrief({
          url: request.url,
          repository: request.repository,
          number: request.number,
          origin: request.origin,
          head,
          worktree,
          branch,
          draft: paths.draft,
        }),
    },
    record: recordLaunch(input.paths, target, request.id),
  });
}

/**
 * Starts the reviewer in the PR repository's Herdr workspace, never in the caller's checkout.
 * A failed start stays visible with every resource that it recorded.
 */
function start(input: { paths: Paths; url: string; profile?: string }) {
  return parseTarget(input.url)
    .toAsync()
    .flatMap((target) =>
      openPullRequest(target).flatMap((pr) =>
        apply(input.paths, target, "start", () => ({
          update: { head: pr.head, failureReason: null, failureDetail: null },
        }))
          .toAsync()
          .flatMap(({ snapshot }) =>
            fromPromise(async () => {
              const id = snapshot.request?.id ?? "";
              const release = DeviceState.holdReviewRequest(input.paths, id);
              try {
                return await launch(input, target, snapshot);
              } finally {
                release();
              }
            }, qualify).flatMap(
              (started): AsyncResult<{ reason: string; data: object }, Failure> => {
                if (started.tag === "Ok")
                  return apply(input.paths, target, "started", () => ({}))
                    .toAsync()
                    .map((done) => ({
                      reason: "reviewer_started",
                      data: { ...summary(input.paths, done.snapshot), launch: started.value },
                    }));
                const error =
                  started.tag === "Err"
                    ? started.error
                    : {
                        reason: "launch_defect",
                        detail: `The start stopped: ${String(started.cause)}`,
                      };
                return apply(input.paths, target, "start_failed", () => ({
                  update: { failureReason: error.reason, failureDetail: error.detail },
                }))
                  .toAsync()
                  .flatMap(() =>
                    ErrAsync<Failure>({
                      reason: "launch_failed",
                      detail: `${error.reason}: ${error.detail} The reviewer start is recorded as failed. Read operator review next.`,
                    }),
                  );
              },
            ),
          ),
      ),
    );
}

const draftJson = z.string().transform((value, context): unknown => {
  try {
    return JSON.parse(value);
  } catch {
    context.addIssue({ code: "custom", message: "The draft is not JSON." });
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
};

function approval(facts: Parameters<typeof decideEvent>[0], event: ReviewEvent) {
  if (approvalBlocked(facts, event))
    return Err<Failure>({
      reason: "review_approval_blocked",
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

/** Every refusal here happens before any write, and before GitHub sees a post. */
function prepare(paths: Paths, target: Target, request: Row) {
  return readDraft(files(paths, request).draft).flatMap((draft) =>
    openPullRequest(target).flatMap((pr) =>
      checkDraft(draft, pr).flatMap((accepted): Result<Prepared, Failure> => {
        const facts = {
          accepted,
          ownPullRequest: pr.author !== null && pr.author === pr.viewer,
          origin: request.origin,
        };
        const event = decideEvent(facts);
        return approval(facts, event).map(() => ({ request, pr, accepted, event }));
      }),
    ),
  );
}

function nextRound(request: Row, rounds: Round[], prepared: Prepared): Round {
  const last = rounds.at(-1);
  const number = last === undefined ? 1 : last.outcome === "posted" ? last.number + 1 : last.number;
  const marker = `<!-- operator-review ${request.id} round ${number} -->`;
  const { body } = renderReview({
    marker,
    event: prepared.event,
    accepted: prepared.accepted,
    requiredChecks: prepared.pr.requiredChecks.length,
  });
  return {
    requestId: request.id,
    number,
    trigger: "first",
    reviewedCommit: prepared.accepted.draft.reviewedCommit,
    draft: JSON.stringify(prepared.accepted.draft),
    event: prepared.event,
    body,
    marker,
    outcome: "pending",
    reviewId: null,
    reviewUrl: null,
    postedAt: null,
  };
}

type Posted = AsyncResult<{ reason: string; data: object }, Failure>;

/** Records what GitHub holds: the posted review and its event, or the failure. */
function finish(
  paths: Paths,
  target: Target,
  round: Round,
  outcome: PostOutcome,
  counts: object,
): Posted {
  if (outcome.status === "posted")
    return apply(
      paths,
      target,
      "posted",
      () => ({
        update: { failureReason: null, failureDetail: null },
        round: {
          ...round,
          event: outcome.review.event,
          outcome: "posted",
          reviewId: outcome.review.id,
          reviewUrl: outcome.review.url,
          postedAt: new Date().toISOString(),
        },
      }),
      outcome.review.event === "APPROVE" ? "APPROVE" : "COMMENT",
    )
      .toAsync()
      .map(({ snapshot }) => ({
        reason: "review_posted",
        data: { ...summary(paths, snapshot), event: outcome.review.event, ...counts },
      }));
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
  return fromPromise(async () => {
    const release = DeviceState.holdReviewRequest(paths, id);
    try {
      return await work();
    } finally {
      release();
    }
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

/** A first post of the current draft. */
function freshPost(paths: Paths, target: Target, request: Row): Posted {
  return prepare(paths, target, request).flatMap((prepared) => {
    const chosen: { round: Round | null } = { round: null };
    return apply(
      paths,
      target,
      "post",
      (_transition, current) => {
        chosen.round = nextRound(prepared.request, current.rounds, prepared);
        return { round: chosen.round };
      },
      prepared.event,
    )
      .toAsync()
      .flatMap(({ transition }): Posted => {
        const round = chosen.round;
        // A concurrent process can turn this post into a retry between the read and the write.
        if (round === null || transition.retry === true)
          return ErrAsync({
            reason: "review_post_in_progress",
            detail: "Another process started this post. Run the post again. Nothing was posted.",
          });
        const counts = {
          blockers:
            prepared.accepted.draft.blockers.length + prepared.accepted.failingChecks.length,
          niceToHaves: prepared.accepted.draft.niceToHaves.length,
        };
        const comments = inlineComments(prepared.accepted.draft);
        return holding(paths, request.id, () =>
          send(target, round, comments).flatMap((outcome) =>
            finish(paths, target, round, outcome, counts),
          ),
        );
      });
  });
}

/**
 * A retry after a post lost its answer. It ignores the current draft and resends the recorded
 * round: GitHub may hold that review, so the marker search runs before any head check.
 */
function retryPost(paths: Paths, target: Target, request: Row, round: Round): Posted {
  return apply(paths, target, "post", () => ({}))
    .toAsync()
    .flatMap(() =>
      holding(paths, request.id, () =>
        readPullRequest(target).flatMap((pr): Posted => {
          const found = pr.reviews.find(
            (review) => review.byViewer && review.body.includes(round.marker),
          );
          if (found !== undefined)
            return finish(
              paths,
              target,
              round,
              { status: "posted", review: { id: found.id, url: found.url, event: found.event } },
              {},
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
          const draft = draftSchema.parse(JSON.parse(round.draft));
          const comments = inlineComments(draft);
          return send(target, round, comments).flatMap((outcome) =>
            finish(paths, target, round, outcome, {}),
          );
        }),
      ),
    );
}

/**
 * The one review write path. It checks the draft, the live PR head, and required CI, computes
 * the event, and posts once. A post that lost its answer is found by its marker, not repeated.
 */
function post(input: { paths: Paths; url: string }) {
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
          const request = snapshot.request;
          if (decided.tag !== "Ok" || request === null)
            return decided
              .toAsync()
              .flatMap(() =>
                ErrAsync({ reason: "review_defect", detail: "The post lost its request." }),
              );
          const pending = snapshot.rounds.at(-1);
          return decided.value.retry === true && pending !== undefined
            ? retryPost(input.paths, target, request, pending)
            : freshPost(input.paths, target, request);
        }),
    );
}

/** The applicable review actions and waits across the device, from recorded state alone. */
function next(paths: Paths) {
  return DeviceState.readReviewRequests(paths).map((rows) => ({
    reason: "review_next",
    data: {
      requests: rows.flatMap((row) => {
        const request = row.request;
        if (request === null) return [];
        const step = reviewAction(request, row.ownerActive);
        return [
          {
            ...summary(paths, row),
            ...(step.kind === "action"
              ? {
                  action: step.action,
                  reason: step.reason,
                  command: `operator review ${step.action === "start_reviewer" ? "start" : "post"} ${request.url}`,
                }
              : { wait: step.reason }),
          },
        ];
      }),
    },
  }));
}

/** Device review operations. A PR URL selects the request, independent of the current folder. */
export const ReviewRequests = {
  add(input: { paths: Paths; url: string }) {
    return add(input);
  },
  start(input: { paths: Paths; url: string; profile?: string }) {
    return start(input);
  },
  post(input: { paths: Paths; url: string }) {
    return post(input);
  },
  next(paths: Paths) {
    return next(paths);
  },
};
