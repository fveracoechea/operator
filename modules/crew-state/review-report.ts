import type { CrewWriter } from "./database.ts";
import { identityOf } from "./identity.ts";
import type { BranchSnapshotRow, SnapshotCommit } from "./branch-review.ts";
import type {
  AxisReport,
  BranchReportInput,
  ReviewReportInput,
  SubAgentRecord,
} from "./review-input.ts";
import { findingId, REVIEW_AXES, type ReviewRow, updateReview } from "./review.ts";
import { reviewFindings, reviewReports } from "./schema.ts";
import { requiredCoverage, storedBehaviorChanges, storedResultKind } from "./submission-input.ts";
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
  | { status: "review-settled"; reviewId: string; state: string }
  | { status: "submission-drift"; reviewId: string; recorded: string; stated: string }
  | { status: "snapshot-drift"; reviewId: string; recorded: string; stated: string }
  | {
      status: "finding-untargeted";
      reviewId: string;
      findings: Array<{ axis: string; key: string }>;
    }
  | {
      status: "finding-target-unknown";
      reviewId: string;
      findings: Array<{ axis: string; key: string; targets: string[] }>;
    }
  | { status: "axes-incomplete"; reviewId: string; missing: string[] }
  | {
      status: "axes-not-parallel";
      reviewId: string;
      windows: Array<{ axis: string; startedAt: string; endedAt: string }>;
    }
  | { status: "host-mismatch"; reviewId: string; recorded: string; stated: string }
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
  reports: Array<Pick<AxisReport, "axis" | "checked">>,
  required: string[],
): Array<{ axis: string; missing: string[] }> {
  return reports.flatMap((report) => {
    const missing = required.filter((token) => !report.checked.includes(token));
    return missing.length === 0 ? [] : [{ axis: report.axis, missing }];
  });
}

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
];

/** The coverage a branch review states. It reads the whole range and names no behavior changes. */
export function branchCoverage(): string[] {
  return requiredCoverage("code", false);
}

/** The fixed subject one report names: a submission, or a branch snapshot. */
export type ReportSubject =
  | { kind: "submission"; submission: SubmissionRow; input: ReviewReportInput }
  | {
      kind: "branch";
      snapshot: BranchSnapshotRow;
      commits: SnapshotCommit[];
      input: BranchReportInput;
    };

/** The finding of a branch report whose targets are missing or outside its snapshot. */
function targetRefusal(
  reviewId: string,
  subject: Extract<ReportSubject, { kind: "branch" }>,
): ReportOutcome | null {
  if (subject.input.kind !== "reported") {
    return null;
  }
  const findings = subject.input.reports.flatMap((report) =>
    report.findings.map((one) => ({ axis: report.axis, key: one.key, targets: one.targets })),
  );
  const untargeted = findings.filter((one) => one.targets.length === 0);
  if (untargeted.length > 0) {
    return {
      status: "finding-untargeted",
      reviewId,
      findings: untargeted.map((one) => ({ axis: one.axis, key: one.key })),
    };
  }
  const held = new Set(subject.commits.map((one) => one.commit));
  const unknown = findings
    .map((one) => ({ ...one, targets: one.targets.filter((target) => !held.has(target)) }))
    .filter((one) => one.targets.length > 0);
  return unknown.length === 0
    ? null
    : { status: "finding-target-unknown", reviewId, findings: unknown };
}

/** The identity a report states against the identity its subject records. */
function subjectDrift(reviewId: string, subject: ReportSubject): ReportOutcome | null {
  if (subject.kind === "submission") {
    // The report names the exact submission it read, so a moved result cannot pass as reviewed.
    return subject.input.submissionIdentity === subject.submission.identity
      ? null
      : {
          status: "submission-drift",
          reviewId,
          recorded: subject.submission.identity,
          stated: subject.input.submissionIdentity,
        };
  }
  // The report names the exact snapshot it read, so a review of another head or another commit
  // list cannot pass as the review of this one (ADR 0017).
  return subject.input.snapshotIdentity === subject.snapshot.identity
    ? null
    : {
        status: "snapshot-drift",
        reviewId,
        recorded: subject.snapshot.identity,
        stated: subject.input.snapshotIdentity,
      };
}

/** The coverage each axis of this subject must state. */
function coverageOf(subject: ReportSubject): string[] {
  return subject.kind === "branch"
    ? branchCoverage()
    : requiredCoverage(
        storedResultKind(subject.submission.resultKind),
        storedBehaviorChanges(subject.submission.behaviorChanges) !== null,
      );
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
    subject: ReportSubject;
    agentHost: string;
    now: string;
  },
): ReportOutcome {
  const { review, subject } = request;
  const input = subject.input;

  if (review.state !== "registered") {
    return { status: "review-settled", reviewId: review.id, state: review.state };
  }
  const drift = subjectDrift(review.id, subject);
  if (drift !== null) {
    return drift;
  }

  // The stated host is what `review show` reports, so it must be the host the launch recorded.
  if (input.host !== request.agentHost) {
    return {
      status: "host-mismatch",
      reviewId: review.id,
      recorded: request.agentHost,
      stated: input.host,
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

  const gaps = coverageGaps(input.reports, coverageOf(subject));
  if (gaps.length > 0) {
    return { status: "coverage-incomplete", reviewId: review.id, gaps };
  }
  const untargeted = subject.kind === "branch" ? targetRefusal(review.id, subject) : null;
  if (untargeted !== null) {
    return untargeted;
  }

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
    submissionId: subject.kind === "submission" ? subject.submission.id : null,
    snapshotId: subject.kind === "branch" ? subject.snapshot.id : null,
    findings,
  };
}
