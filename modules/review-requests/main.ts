import { Err, ErrAsync, OkAsync, fromPromise, type AsyncResult } from "unthrown";
import { DeviceState } from "../device-state/main.ts";
import { post } from "./post.ts";
import {
  apply,
  openPullRequest,
  parseTarget,
  qualify,
  summary,
  type Failure,
  type Outcome,
  type Paths,
} from "./request.ts";
import { claimCleanup, cleanupReviewer, launch, syncReviewer } from "./reviewer.ts";
import { rows, wait } from "./watch.ts";
import { acknowledge, ingest, slackActions } from "./slack.ts";
import type { Target } from "./github.ts";
import { markerPrefix } from "./review-body.ts";

/**
 * Records a manual request. It uses the Slack-origin contract, and it needs no Slack transport.
 * A repeated add of a watching or approved request is a renewed request, so a round starts.
 */
function add(input: { paths: Paths; url: string }) {
  return parseTarget(input.url)
    .toAsync()
    .flatMap((target) =>
      openPullRequest(target).flatMap((pr): AsyncResult<Outcome, Failure> =>
        apply(
          input.paths,
          target,
          "add",
          () => ({
            insert: {
              id: crypto.randomUUID(),
              repository: target.repository,
              number: target.number,
              url: target.url,
              origin: "slack",
              state: "queued",
            },
          }),
          { to: pr.head },
        )
          .toAsync()
          .flatMap(({ snapshot, transition }): AsyncResult<Outcome, Failure> => {
            const reason =
              transition.unchanged === true
                ? "review_unchanged"
                : transition.round === undefined
                  ? "review_queued"
                  : "review_round_started";
            if (transition.sync !== true)
              return OkAsync({ reason, data: summary(input.paths, snapshot) ?? {} });
            return syncReviewer(input.paths, target, snapshot).flatMap(() =>
              DeviceState.readReviewRequest(input.paths, target)
                .toAsync()
                .map((after) => ({ reason, data: summary(input.paths, after) ?? {} })),
            );
          }),
      ),
    );
}

/**
 * Starts the reviewer in the PR repository's Herdr workspace, never in the caller's checkout,
 * or replaces a reviewer that stopped. A failed start stays visible with every resource that it
 * recorded.
 */
function start(input: { paths: Paths; url: string; profile?: string }) {
  return parseTarget(input.url)
    .toAsync()
    .flatMap((target) =>
      openPullRequest(target).flatMap((pr) =>
        apply(input.paths, target, "start", (transition, current) => ({
          // A replacement keeps the recorded head, so newer commits still start a round.
          update: {
            // Stryker disable next-line OptionalChaining: equivalent: a start that the machine allows always reads its request
            head: transition.replace === true ? (current.request?.head ?? pr.head) : pr.head,
            failureReason: null,
            failureDetail: null,
          },
        }))
          .toAsync()
          .flatMap(({ snapshot, transition }) =>
            fromPromise(async () => {
              // Stryker disable next-line OptionalChaining, StringLiteral: equivalent: a start that the machine allows always has its request, so the fallback never runs
              const id = snapshot.request?.id ?? "";
              const release = DeviceState.holdReviewRequest(input.paths, id);
              try {
                return await launch(input, target, snapshot, transition.replace === true);
              } finally {
                release();
              }
            }, qualify).flatMap((started): AsyncResult<Outcome, Failure> => {
              if (started.tag === "Ok")
                return apply(input.paths, target, "started")
                  .toAsync()
                  .map((done) => ({
                    reason: transition.replace === true ? "reviewer_replaced" : "reviewer_started",
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
            }),
          ),
      ),
    );
}

/** Ends one PR's request without a post and cleans up its reviewer. A skip names no author. */
function skip(input: { paths: Paths; url: string }) {
  return parseTarget(input.url)
    .toAsync()
    .flatMap((target) =>
      apply(input.paths, target, "skip")
        .toAsync()
        .flatMap(({ snapshot }) =>
          cleanupReviewer(input.paths, target, snapshot).map((cleanup) => ({
            reason: "review_skipped",
            data: { ...summary(input.paths, snapshot), state: "skipped", cleanup },
          })),
        ),
    );
}

function cleanupTarget(paths: Paths, target: Target) {
  return DeviceState.readReviewRequest(paths, target).flatMap((snapshot) => {
    if (snapshot.request !== null)
      return Err<Failure>({
        reason: "review_request_open",
        detail: `The review request of PR #${target.number} is ${snapshot.request.state}. Only a closed or skipped request is cleaned up. Nothing changed.`,
      });
    return snapshot.ended === null
      ? Err<Failure>({
          reason: "review_cleanup_unchanged",
          detail: `No closed or skipped request of PR #${target.number} has a reviewer cleanup left.`,
        })
      : claimCleanup(paths, target, snapshot.ended.id);
  });
}

/** Repeats a reviewer cleanup that failed or kept unlanded work that the person removed. */
function cleanup(input: { paths: Paths; url: string }) {
  return parseTarget(input.url)
    .toAsync()
    .flatMap((target) =>
      cleanupTarget(input.paths, target)
        .toAsync()
        .flatMap((snapshot) =>
          cleanupReviewer(input.paths, target, snapshot).map((outcome) => ({
            reason: outcome.state === "done" ? "reviewer_cleaned" : "reviewer_cleanup_incomplete",
            data: { ...summary(input.paths, snapshot), cleanup: outcome },
          })),
        ),
    );
}

/** The applicable review actions and waits across the device, from recorded state alone. */
function next(paths: Paths) {
  return DeviceState.readReviewRequests(paths)
    .toAsync()
    .flatMap((listed) =>
      slackActions(paths, false).map((slack) => ({
        reason: "review_next",
        data: { requests: rows(paths, listed), slack },
      })),
    );
}

/** Device review operations. A PR URL selects the request, independent of the current folder. */
export const ReviewRequests = {
  /** Every review that Operator posts starts with its marker, from any account. */
  isOperatorReview(body: string) {
    return body.startsWith(markerPrefix);
  },
  add(input: { paths: Paths; url: string }) {
    return add(input);
  },
  start(input: { paths: Paths; url: string; profile?: string }) {
    return start(input);
  },
  post(input: { paths: Paths; url: string }) {
    return post(input);
  },
  skip(input: { paths: Paths; url: string }) {
    return skip(input);
  },
  cleanup(input: { paths: Paths; url: string }) {
    return cleanup(input);
  },
  next(paths: Paths) {
    return next(paths);
  },
  /** Records the eligible PRs of one raw Slack channel read and moves the channel cursor. */
  ingest(input: { paths: Paths; text: string }) {
    return ingest(input);
  },
  /** Records the agent's report of one sent Slack effect from the raw send result. */
  acknowledge(input: { paths: Paths; id: string; text: string }) {
    return acknowledge(input);
  },
  /** Watches every open request until a round, a move, an end, or an action needs attention. */
  wait(input: { paths: Paths; timeoutSeconds: number; slack: boolean }) {
    return wait(input);
  },
};
