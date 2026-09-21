import { readState, type StateFailure } from "./operations.ts";
import { findingsOf, missingAxes, readReview, reportsOf, undisposed } from "./review.ts";
import {
  storedAxes,
  storedBlocker,
  storedChecked,
  storedObservedChecks,
  storedSubAgents,
} from "./review-input.ts";
import { storedChecks, storedCode, storedConcerns, storedDecisions } from "./submission-input.ts";
import { readSubmission } from "./submission.ts";
import { storedArtifacts } from "./submission-store.ts";

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
    observedChecks: unknown;
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
  | { status: "submission-missing"; reviewId: string; submissionId: string }
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
      // The review exists. Saying it does not would send the reader looking for the wrong fault.
      return {
        status: "submission-missing" as const,
        reviewId: review.id,
        submissionId: review.submissionId,
      };
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
        axes: storedAxes(review.axes),
        subAgents: review.subAgents === null ? null : storedSubAgents(review.subAgents),
        blocker: review.blocker === null ? null : storedBlocker(review.blocker),
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
        artifacts: storedArtifacts(submission.artifacts),
        checks: storedChecks(submission.checks),
        concerns: storedConcerns(submission.concerns),
        decisions: storedDecisions(submission.decisions),
        code: submission.code === null ? null : storedCode(submission.code),
      },
      reports: reports.map((one) => ({
        axis: one.axis,
        summary: one.summary,
        checked: storedChecked(one.checked),
        observedChecks: storedObservedChecks(one.observedChecks),
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
      outstanding: undisposed(findings).map((one) => one.id),
    };
  });
}
