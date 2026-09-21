import { OperatorConfig } from "../operator-config/main.ts";
import { type AttemptFailure, readContext, type Shared } from "./dispatch-context.ts";
import { mutate, readState } from "./operations.ts";
import { reviewReportInputSchema } from "./review-input.ts";
import { type ReportOutcome, recordReviewReport } from "./review-report.ts";
import { readReview } from "./review.ts";
import { readSubmission } from "./submission.ts";

export type RecordReviewResult =
  | ReportOutcome
  | { status: "invalid-input"; issues: string[] }
  | { status: "unknown-review"; reviewId: string }
  | { status: "review-not-assigned"; reviewId: string; assignmentId: string }
  | { status: "not-dispatched"; attemptId: string }
  | { status: "not-acknowledged"; attemptId: string }
  | { status: "reference-mismatch"; attemptId: string; detail: string }
  | AttemptFailure
  | Shared;

/**
 * Records the result of one review from the reviewer's own worktree.
 * It carries no ownership token, so the review attempt it runs under must still be the current
 * writer of its review assignment.
 */
export async function recordReview(request: {
  projectRoot: string;
  requestId: string;
  reviewId: string;
  attemptId: string;
  worktreePath: string;
  input: unknown;
}): Promise<{ repeated: boolean; result: RecordReviewResult }> {
  const parsed = reviewReportInputSchema.safeParse(request.input);
  if (!parsed.success) {
    return {
      repeated: false,
      result: {
        status: "invalid-input",
        issues: parsed.error.issues.map(OperatorConfig.describeIssue),
      },
    };
  }

  const read = await readContext(request.projectRoot, {
    attemptId: request.attemptId,
    ownerToken: null,
  });
  if (read.status !== "ok") {
    return { repeated: false, result: read };
  }

  const dispatch = read.context.dispatch;
  if (dispatch === null) {
    return { repeated: false, result: { status: "not-dispatched", attemptId: request.attemptId } };
  }
  if (dispatch.worktreePath !== request.worktreePath) {
    return {
      repeated: false,
      result: {
        status: "reference-mismatch",
        attemptId: request.attemptId,
        detail: `This attempt is recorded against ${dispatch.worktreePath}.`,
      },
    };
  }
  if (dispatch.acknowledgedAt === null) {
    return {
      repeated: false,
      result: { status: "not-acknowledged", attemptId: request.attemptId },
    };
  }

  const bound = await readState(request.projectRoot, (db) => {
    const review = readReview(db, request.reviewId);
    if (review === null) {
      return { status: "unknown-review" as const, reviewId: request.reviewId };
    }
    // The reviewer reports only the review its own assignment carries.
    return review.assignmentId === read.context.attempt.assignmentId
      ? { status: "ok" as const }
      : {
          status: "review-not-assigned" as const,
          reviewId: review.id,
          assignmentId: review.assignmentId,
        };
  });
  if (bound.status !== "ok") {
    return { repeated: false, result: bound };
  }

  const input = parsed.data;
  return mutate<ReportOutcome>(
    {
      projectRoot: request.projectRoot,
      requestId: request.requestId,
      ownerToken: null,
      now: new Date().toISOString(),
      operation: "review_report",
      input: { reviewId: request.reviewId, report: input },
    },
    ({ tx, now }) => {
      const review = readReview(tx, request.reviewId);
      if (review === null) {
        return {
          commit: false,
          outcome: { status: "review-settled", reviewId: request.reviewId, state: "unknown" },
        };
      }

      const submission = readSubmission(tx, review.submissionId);
      if (submission === null) {
        return {
          commit: false,
          outcome: { status: "review-settled", reviewId: review.id, state: "unknown-submission" },
        };
      }

      const outcome = recordReviewReport(tx, {
        review,
        submission,
        agentHost: dispatch.agentHost,
        input,
        now,
      });
      return { commit: outcome.status === "reported" || outcome.status === "blocked", outcome };
    },
  );
}
