import type { CrewWriter } from "./database.ts";
import { identityOf } from "./identity.ts";
import type { AxisReport, ReviewReportInput, SubAgentRecord } from "./review-input.ts";
import { findingId, REVIEW_AXES, type ReviewRow, updateReview } from "./review.ts";
import { reviewFindings, reviewReports } from "./schema.ts";
import { requiredCoverage } from "./submission-input.ts";
import type { SubmissionRow } from "./submission.ts";

export type ReportedFinding = {
  findingId: string;
  axis: string;
  key: string;
  severity: string;
  summary: string;
};

export type ReportOutcome =
  | {
      status: "reported";
      reviewId: string;
      assignmentId: string;
      submissionId: string;
      findings: ReportedFinding[];
    }
  | {
      status: "blocked";
      reviewId: string;
      assignmentId: string;
      reason: string;
      detail: string;
    }
  | { status: "review-settled"; reviewId: string; state: string }
  | { status: "submission-drift"; reviewId: string; recorded: string; stated: string }
  | { status: "axes-incomplete"; reviewId: string; missing: string[] }
  | {
      status: "axes-not-parallel";
      reviewId: string;
      windows: Array<{ axis: string; startedAt: string; endedAt: string }>;
    }
  | { status: "sub-agent-host-mismatch"; reviewId: string; recorded: string; stated: string[] }
  | { status: "sub-agent-failed"; reviewId: string; axes: string[] }
  | {
      status: "coverage-incomplete";
      reviewId: string;
      gaps: Array<{ axis: string; missing: string[] }>;
    };

/** The required axes one list does not state exactly once, which is what makes it incomplete. */
function axesNotStatedOnce(entries: Array<{ axis: string }>): string[] {
  return REVIEW_AXES.filter((axis) => entries.filter((one) => one.axis === axis).length !== 1);
}

/**
 * True when both sub-agent windows overlap.
 * The skill requires the two axes to run in parallel and in separate contexts, so a pair that
 * ran one after the other is a different review than the one that was approved.
 */
function ranInParallel(subAgents: SubAgentRecord[]): boolean {
  const latestStart = subAgents
    .map((one) => Date.parse(one.startedAt))
    .reduce((highest, value) => Math.max(highest, value), Number.NEGATIVE_INFINITY);
  const earliestEnd = subAgents
    .map((one) => Date.parse(one.endedAt))
    .reduce((lowest, value) => Math.min(lowest, value), Number.POSITIVE_INFINITY);
  return latestStart < earliestEnd;
}

function coverageGaps(
  reports: AxisReport[],
  resultKind: string,
): Array<{ axis: string; missing: string[] }> {
  const required = requiredCoverage(resultKind);
  return reports.flatMap((report) => {
    const missing = required.filter((token) => !report.checked.includes(token));
    return missing.length === 0 ? [] : [{ axis: report.axis, missing }];
  });
}

/**
 * Records the two axis reports of one review, or the blocker that stopped it.
 * A review report is the end of the review chain: it is never a submitted result, so it never
 * starts another review.
 */
export function recordReviewReport(
  db: CrewWriter,
  request: {
    review: ReviewRow;
    submission: SubmissionRow;
    agentHost: string;
    input: ReviewReportInput;
    now: string;
  },
): ReportOutcome {
  const { review, submission, input } = request;

  if (review.state !== "registered") {
    return { status: "review-settled", reviewId: review.id, state: review.state };
  }
  // The report names the exact submission it read, so a moved result cannot pass as reviewed.
  if (input.submissionIdentity !== submission.identity) {
    return {
      status: "submission-drift",
      reviewId: review.id,
      recorded: submission.identity,
      stated: input.submissionIdentity,
    };
  }

  if (input.kind === "blocked") {
    updateReview(db, {
      review,
      state: "blocked",
      host: input.host,
      subAgents: null,
      blocker: input.blocker,
      reportedAt: null,
      now: request.now,
    });
    return {
      status: "blocked",
      reviewId: review.id,
      assignmentId: review.assignmentId,
      reason: input.blocker.reason,
      detail: input.blocker.detail,
    };
  }

  const missing = [
    ...new Set([...axesNotStatedOnce(input.reports), ...axesNotStatedOnce(input.subAgents)]),
  ];
  if (missing.length > 0) {
    return { status: "axes-incomplete", reviewId: review.id, missing };
  }

  // The sub-agents are native to the reviewer host, so they hold no Herdr slot of their own.
  const foreign = [...new Set(input.subAgents.map((one) => one.host))].filter(
    (host) => host !== request.agentHost,
  );
  if (foreign.length > 0) {
    return {
      status: "sub-agent-host-mismatch",
      reviewId: review.id,
      recorded: request.agentHost,
      stated: foreign,
    };
  }

  const failed = input.subAgents.filter((one) => one.status !== "completed").map((one) => one.axis);
  if (failed.length > 0) {
    return { status: "sub-agent-failed", reviewId: review.id, axes: failed };
  }

  if (!ranInParallel(input.subAgents)) {
    return {
      status: "axes-not-parallel",
      reviewId: review.id,
      windows: input.subAgents.map((one) => ({
        axis: one.axis,
        startedAt: one.startedAt,
        endedAt: one.endedAt,
      })),
    };
  }

  const gaps = coverageGaps(input.reports, submission.resultKind);
  if (gaps.length > 0) {
    return { status: "coverage-incomplete", reviewId: review.id, gaps };
  }

  const findings: ReportedFinding[] = [];
  for (const report of input.reports) {
    db.insert(reviewReports)
      .values({
        id: identityOf({ reviewId: review.id, axis: report.axis }).slice(0, 32),
        reviewId: review.id,
        axis: report.axis,
        summary: report.summary,
        checked: JSON.stringify(report.checked),
        findingCount: report.findings.length,
        identity: identityOf(report),
        recordedAt: request.now,
      })
      .run();

    for (const finding of report.findings) {
      const id = findingId(review.id, report.axis, finding.key);
      db.insert(reviewFindings)
        .values({
          id,
          reviewId: review.id,
          axis: report.axis,
          findingKey: finding.key,
          severity: finding.severity,
          summary: finding.summary,
          evidence: finding.evidence,
          disposition: null,
          reason: null,
          followUp: null,
          disposedAt: null,
          recordedAt: request.now,
        })
        .run();
      findings.push({
        findingId: id,
        axis: report.axis,
        key: finding.key,
        severity: finding.severity,
        summary: finding.summary,
      });
    }
  }

  updateReview(db, {
    review,
    state: "reported",
    host: input.host,
    subAgents: input.subAgents,
    blocker: null,
    reportedAt: request.now,
    now: request.now,
  });

  return {
    status: "reported",
    reviewId: review.id,
    assignmentId: review.assignmentId,
    submissionId: submission.id,
    findings,
  };
}
