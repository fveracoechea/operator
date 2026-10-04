import type { CrewWriter } from "./database.ts";
import { identityOf } from "./identity.ts";
import type { AxisReport } from "./review-input.ts";
import { Review, type ReportRefusal, type ReportSubject } from "./review-machine.ts";
import { findingId, type ReviewRow, updateReview } from "./review.ts";
import { eq } from "drizzle-orm";
import { reviewFindings, reviewReports, reviews } from "./schema.ts";

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
      submissionId: string | null;
      snapshotId: string | null;
      findings: ReportedFinding[];
    }
  | {
      status: "blocked";
      reviewId: string;
      assignmentId: string;
      reason: string;
      detail: string;
    }
  | ReportRefusal;

/**
 * The rules this report refuses, in the order it checks them, each with the refusal name the CLI
 * reports for it. The brief places these lines beside the report command and words none itself.
 */
export const REPORT_RULES = [
  // `recordReview` reads the reviewer checkout before it records anything.
  {
    refusal: "review_worktree_changed",
    rule: "Never edit a file or commit in this checkout.",
  },
  {
    refusal: "submission_drift",
    rule: "`submissionIdentity` is the identity of the submission above.",
  },
  {
    refusal: "review_host_mismatch",
    rule: "`host` is the crew host under Effective configuration.",
  },
  {
    refusal: "review_axes_incomplete",
    rule: "`reports` and `subAgents` each name every axis exactly once.",
  },
  { refusal: "review_sub_agent_host_mismatch", rule: "Every sub-agent runs on that same host." },
  {
    refusal: "review_sub_agent_failed",
    rule: "Every sub-agent completed. If one could not, record the blocker below instead.",
  },
  {
    refusal: "review_axes_not_parallel",
    rule: "The two sub-agent windows overlap, because the two axes run at the same time.",
  },
  {
    refusal: "review_coverage_incomplete",
    rule: "Each axis states in `checked` every reading that this result kind requires.",
  },
  {
    refusal: "review_published_text_missing",
    rule: "`published` holds the pull request text when the brief asks for it.",
  },
];

/**
 * The rules a branch review report refuses beyond the shared ones, each with its refusal name.
 * A branch finding is corrected by invalidating the assignment of one target commit, so a
 * finding with no target, or with a commit outside the snapshot, could never be answered.
 */
export const BRANCH_REPORT_RULES = [
  {
    refusal: "review_finding_untargeted",
    rule: "Every finding names at least one commit of the snapshot in `targets`.",
  },
  {
    refusal: "review_finding_target_unknown",
    rule: "Every target is the full SHA of one commit listed in the branch snapshot above.",
  },
  {
    refusal: "review_cut_not_between_commits",
    rule: "Each cut in `published.cuts` names, in landing order, a commit of the snapshot above that is not the head.",
  },
];

/**
 * Records the two axis reports of one review, or the blocker that stopped it.
 * A review report is the end of the review chain: it is never a submitted result, so it never
 * starts another review.
 */
export function recordReviewReport(
  db: CrewWriter,
  request: {
    review: ReviewRow;
    subject: ReportSubject;
    agentHost: string;
    now: string;
  },
): ReportOutcome {
  const { review, subject } = request;
  const input = subject.input;
  const facts = { row: review, subject, agentHost: request.agentHost };

  if (input.kind === "blocked") {
    const decided = Review.decide("block", facts);
    if ("refused" in decided) {
      return decided.refused;
    }
    updateReview(db, {
      review,
      state: decided.next,
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

  const decided = Review.decide("report", facts);
  if ("refused" in decided) {
    return decided.refused;
  }
  const published = input.published ?? null;

  const findings: ReportedFinding[] = [];
  const reports: Array<AxisReport & { findings: Array<{ targets?: string[] }> }> = input.reports;
  for (const report of reports) {
    db.insert(reviewReports)
      .values({
        id: identityOf({ reviewId: review.id, axis: report.axis }).slice(0, 32),
        reviewId: review.id,
        axis: report.axis,
        summary: report.summary,
        checked: JSON.stringify(report.checked),
        observedChecks: JSON.stringify(report.observedChecks),
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
          targets: finding.targets === undefined ? null : JSON.stringify(finding.targets),
          correctionTarget: null,
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
    state: decided.next,
    host: input.host,
    subAgents: input.subAgents,
    blocker: null,
    reportedAt: request.now,
    now: request.now,
  });
  if (published !== null) {
    db.update(reviews)
      .set({ publishedText: JSON.stringify(published) })
      .where(eq(reviews.id, review.id))
      .run();
  }

  return {
    status: "reported",
    reviewId: review.id,
    assignmentId: review.assignmentId,
    submissionId: subject.kind === "submission" ? subject.submission.id : null,
    snapshotId: subject.kind === "branch" ? subject.snapshot.id : null,
    findings,
  };
}
