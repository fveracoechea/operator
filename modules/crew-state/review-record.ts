import { OperativeDispatch } from "../operative-dispatch/main.ts";
import { readWriterContext, type WriterFailure } from "./dispatch-context.ts";
import { type InvalidInput, parseInput } from "./input.ts";
import { mutate, readState } from "./operations.ts";
import { readSnapshot, storedSnapshotCommits } from "./branch-review.ts";
import { branchReportInputSchema, reviewReportInputSchema } from "./review-input.ts";
import { type ReportOutcome, type ReportSubject, recordReviewReport } from "./review-report.ts";
import { readReview, type ReviewRow } from "./review.ts";
import type { CrewReader } from "./database.ts";
import type { BranchReportInput, ReviewReportInput } from "./review-input.ts";
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

/** The fixed subject one review reads, with the report that names it, or null when it is gone. */
function subjectOf(
  db: CrewReader,
  review: ReviewRow,
  input: ReviewReportInput | BranchReportInput,
): ReportSubject | null {
  if (review.snapshotId !== null) {
    const snapshot = readSnapshot(db, review.snapshotId);
    return snapshot === null || !("snapshotIdentity" in input)
      ? null
      : { kind: "branch", snapshot, commits: storedSnapshotCommits(snapshot.commits), input };
  }
  const submission = review.submissionId === null ? null : readSubmission(db, review.submissionId);
  return submission === null || !("submissionIdentity" in input)
    ? null
    : { kind: "submission", submission, input };
}

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
  // A branch review names its snapshot and the targets of each finding, so its report is read
  // through its own shape. A review this state does not hold is refused further on.
  const branch = await readState(
    request.projectRoot,
    (db) => readReview(db, request.reviewId)?.snapshotId != null,
  );
  if (typeof branch !== "boolean") {
    return { repeated: false, result: branch };
  }
  const parsed = branch
    ? parseInput(branchReportInputSchema, request.input)
    : parseInput(reviewReportInputSchema, request.input);
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
  const worktree = await OperativeDispatch.inspectCheckout({
    worktreePath: request.worktreePath,
    baseCommit: dispatch.baseCommit,
    agentHost: dispatch.agentHost,
  });
  // A reading that failed finds nothing, as the review check always did. Submit is stricter.
  const changes = worktree.uncommitted.status === "read" ? worktree.uncommitted.value : [];
  const commits =
    worktree.commits.status === "read" ? worktree.commits.value.map((one) => one.commit) : [];
  if (changes.length > 0 || commits.length > 0) {
    return {
      repeated: false,
      result: { status: "worktree-changed", attemptId: request.attemptId, changes, commits },
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

      const subject = subjectOf(tx, review, input);
      if (subject === null) {
        return {
          commit: false,
          outcome: { status: "review-settled", reviewId: review.id, state: "unknown-submission" },
        };
      }

      const outcome = recordReviewReport(tx, {
        review,
        subject,
        agentHost: dispatch.agentHost,
        now,
      });
      return { commit: outcome.status === "reported" || outcome.status === "blocked", outcome };
    },
  );
}
