import { Err, ErrAsync, OkAsync, fromPromise, type AsyncResult } from "unthrown";
import { DeviceState } from "../device-state/main.ts";
import { DeviceSettings } from "../device-settings/main.ts";
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
import { claimCleanup, cleanupResult, cleanupReviewer, launch, syncReviewer } from "./reviewer.ts";
import { rows, wait } from "./watch.ts";
import type { Target } from "./github.ts";
import { markerPrefix } from "./review-body.ts";

/**
 * Records a manual request after applying the device's repository and author policy.
 * A repeated add of a watching or approved request is a renewed request, so a round starts.
 */
function add(input: { paths: Paths; url: string; slackThread?: string }) {
  return parseTarget(input.url)
    .toAsync()
    .flatMap((target) =>
      openPullRequest(target).flatMap((pr) =>
        DeviceSettings.reviewPolicy(input.paths).flatMap(
          (policy): AsyncResult<Outcome, Failure> => {
            if (
              !policy.repos.includes(target.repository) ||
              pr.author === null ||
              !policy.authors.some((author) => author.toLowerCase() === pr.author?.toLowerCase())
            )
              return ErrAsync({
                reason: "review_author_excluded",
                detail:
                  "The repository or GitHub author is outside the device author policy. Nothing changed.",
                next: {
                  decider: "super-agent",
                  question:
                    "Skip this PR, or ask the person whether the review policy should change?",
                },
                state: { repository: target.repository, author: pr.author },
              });
            return apply(
              input.paths,
              target,
              "add",
              () => ({
                insert: {
                  id: crypto.randomUUID(),
                  repository: target.repository,
                  number: target.number,
                  url: target.url,
                  origin: "manual",
                  state: "queued",
                  slackThread: input.slackThread ?? null,
                },
                update:
                  input.slackThread === undefined ? undefined : { slackThread: input.slackThread },
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
              });
          },
        ),
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
            // The cleanup of an earlier reviewer does not describe the new one.
            cleanupState: null,
            cleanupDetail: null,
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

/**
 * Posts the reviewer's draft. An approval cleans up the reviewer in the same command. A cleanup
 * that stops before it ends is finished by the next wait, and a failed one stays visible.
 */
function postReview(input: { paths: Paths; url: string }) {
  return post(input).flatMap((posted) =>
    parseTarget(input.url)
      .toAsync()
      .flatMap((target) =>
        DeviceState.readReviewRequest(input.paths, target)
          .toAsync()
          .flatMap((snapshot): AsyncResult<Outcome, Failure> => {
            // Of the posts that succeed, only an approval keeps the lease for its cleanup.
            // Stryker disable next-line OptionalChaining: equivalent: a successful post always leaves its request
            if (snapshot.request?.ownerPid !== process.pid) return OkAsync(posted);
            return fromPromise(
              async () => cleanupResult(await cleanupReviewer(input.paths, target, snapshot)),
              qualify,
            ).flatMap((cleanup) =>
              // The result shows the reviewer after its cleanup.
              DeviceState.readReviewRequest(input.paths, target)
                .toAsync()
                .map((after) => ({
                  ...posted,
                  data: { ...posted.data, ...summary(input.paths, after), cleanup },
                })),
            );
          }),
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

/**
 * An approved request keeps its record, so its reviewer is cleaned up while it stays open. A
 * renewal moves a request whose cleanup kept unlanded work, and that work stays for a cleanup.
 */
function cleanupTarget(paths: Paths, target: Target) {
  return DeviceState.readReviewRequest(paths, target).flatMap((snapshot) => {
    const request = snapshot.request;
    if (
      request?.state === "approved" ||
      request?.cleanupState === "kept" ||
      request?.cleanupState === "pending"
    )
      // Stryker disable next-line OptionalChaining, StringLiteral: equivalent: both conditions above hold only for a recorded request
      return claimCleanup(paths, target, request?.id ?? "");
    if (request !== null)
      return Err<Failure>({
        reason: "review_request_open",
        detail: `The review request of PR #${target.number} is ${request.state}. Only an approved, closed, or skipped request, or one with kept reviewer work, is cleaned up. Nothing changed.`,
      });
    return snapshot.ended === null
      ? Err<Failure>({
          reason: "review_cleanup_unchanged",
          detail: `No approved, closed, or skipped request of PR #${target.number} has a reviewer cleanup left.`,
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
    .map((listed) => ({
      reason: "review_next",
      data: { requests: rows(paths, listed) },
    }));
}

/** Device review operations. A PR URL selects the request, independent of the current folder. */
export const ReviewRequests = {
  /** Every review that Operator posts starts with its marker, from any account. */
  isOperatorReview(body: string) {
    return body.startsWith(markerPrefix);
  },
  add(input: { paths: Paths; url: string; slackThread?: string }) {
    return add(input);
  },
  start(input: { paths: Paths; url: string; profile?: string }) {
    return start(input);
  },
  post(input: { paths: Paths; url: string }) {
    return postReview(input);
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
  /**
   * Watches every open request until a round, a move, an end, or an action needs attention. It
   * returns the requests that its events name and those with an action, or with `all` every one.
   */
  wait(input: { paths: Paths; timeoutSeconds: number; all?: boolean }) {
    return wait(input);
  },
};
