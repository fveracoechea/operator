import { OperativeDispatch } from "../operative-dispatch/main.ts";
import { readWriterContext, type WriterFailure } from "./dispatch-context.ts";
import { type InvalidInput, parseInput } from "./input.ts";
import { mutate, readState } from "./operations.ts";
import { reviewReportInputSchema } from "./review-input.ts";
import { type ReportOutcome, recordReviewReport } from "./review-report.ts";
import { readReview } from "./review.ts";
import { readSubmission } from "./submission.ts";

export type RecordReviewResult =
  | ReportOutcome
  | InvalidInput
  | { status: "unknown-review"; reviewId: string }
  | { status: "review-not-assigned"; reviewId: string; assignmentId: string }
  | {
      status: "worktree-changed";
      attemptId: string;
      changes: string[];
      commits: string[];
    }
  | WriterFailure;

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
  const parsed = parseInput(reviewReportInputSchema, request.input);
  if (parsed.status !== "parsed") {
    return { repeated: false, result: parsed };
  }

  const read = await readWriterContext(request.projectRoot, request);
  if (read.status !== "ok") {
    return { repeated: false, result: read };
  }
  const dispatch = read.dispatch;

  // A review reads and runs checks. An edit or a commit in its own checkout is rework, which
  // belongs to a fresh Operative, so the report is refused instead of recorded beside it.
  const worktree = await OperativeDispatch.inspectReviewWorktree({
    worktreePath: request.worktreePath,
    baseCommit: dispatch.baseCommit,
    agentHost: dispatch.agentHost,
  });
  if (worktree.changes.length > 0 || worktree.commits.length > 0) {
    return {
      repeated: false,
      result: {
        status: "worktree-changed",
        attemptId: request.attemptId,
        changes: worktree.changes,
        commits: worktree.commits,
      },
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

  const input = parsed.value;
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
