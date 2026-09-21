import { readState, type StateFailure } from "./operations.ts";
import { findingsOf, missingAxes, readReview, reportsOf } from "./review.ts";
import { readSubmission } from "./submission.ts";

export type ReviewReport = {
  review: {
    id: string;
    submissionId: string;
    assignmentId: string;
    state: string;
    host: string | null;
    axes: unknown;
    subAgents: unknown;
    blocker: unknown;
    reportedAt: string | null;
    revision: number;
  };
  submission: {
    id: string;
    assignmentId: string;
    attemptId: string;
    resultKind: string;
    assignmentRevision: number;
    sourceRevision: string;
    requirementsIdentity: string;
    identity: string;
    state: string;
    reviewBase: string | null;
    artifacts: unknown;
    checks: unknown;
    concerns: unknown;
    decisions: unknown;
    code: unknown;
  };
  reports: Array<{
    axis: string;
    summary: string;
    checked: unknown;
    findingCount: number;
    identity: string;
  }>;
  findings: Array<{
    findingId: string;
    axis: string;
    key: string;
    severity: string;
    summary: string;
    evidence: string;
    disposition: string | null;
    reason: string | null;
    followUp: string | null;
  }>;
  missingAxes: string[];
  outstanding: string[];
};

export type ShowReviewResult =
  | ({ status: "reported" } & ReviewReport)
  | { status: "unknown-review"; reviewId: string }
  | StateFailure;

/** Reports one review, its two axis reports, and every finding disposition. Writes nothing. */
export async function showReview(request: {
  projectRoot: string;
  reviewId: string;
}): Promise<ShowReviewResult> {
  return readState(request.projectRoot, (db) => {
    const review = readReview(db, request.reviewId);
    if (review === null) {
      return { status: "unknown-review" as const, reviewId: request.reviewId };
    }

    const submission = readSubmission(db, review.submissionId);
    if (submission === null) {
      return { status: "unknown-review" as const, reviewId: request.reviewId };
    }

    const reports = reportsOf(db, review.id);
    const findings = findingsOf(db, review.id);

    return {
      status: "reported" as const,
      review: {
        id: review.id,
        submissionId: review.submissionId,
        assignmentId: review.assignmentId,
        state: review.state,
        host: review.host,
        axes: JSON.parse(review.axes),
        subAgents: review.subAgents === null ? null : JSON.parse(review.subAgents),
        blocker: review.blocker === null ? null : JSON.parse(review.blocker),
        reportedAt: review.reportedAt,
        revision: review.revision,
      },
      submission: {
        id: submission.id,
        assignmentId: submission.assignmentId,
        attemptId: submission.attemptId,
        resultKind: submission.resultKind,
        assignmentRevision: submission.assignmentRevision,
        sourceRevision: submission.sourceRevision,
        requirementsIdentity: submission.requirementsIdentity,
        identity: submission.identity,
        state: submission.state,
        reviewBase: submission.reviewBase,
        artifacts: JSON.parse(submission.artifacts),
        checks: JSON.parse(submission.checks),
        concerns: JSON.parse(submission.concerns),
        decisions: JSON.parse(submission.decisions),
        code: submission.code === null ? null : JSON.parse(submission.code),
      },
      reports: reports.map((one) => ({
        axis: one.axis,
        summary: one.summary,
        checked: JSON.parse(one.checked),
        findingCount: one.findingCount,
        identity: one.identity,
      })),
      findings: findings.map((one) => ({
        findingId: one.id,
        axis: one.axis,
        key: one.findingKey,
        severity: one.severity,
        summary: one.summary,
        evidence: one.evidence,
        disposition: one.disposition,
        reason: one.reason,
        followUp: one.followUp,
      })),
      missingAxes: missingAxes(reports),
      outstanding: findings.filter((one) => one.disposition === null).map((one) => one.id),
    };
  });
}
