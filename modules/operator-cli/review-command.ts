import { CrewState } from "../crew-state/main.ts";
import type { ParsedArguments } from "./arguments.ts";
import { readStructuredInput, readWorktreeReference, reportSharedFailure } from "./crew-result.ts";
import { report } from "./result.ts";

type Handled = "reported" | "invalid-arguments";

async function runReport(parsed: ParsedArguments): Promise<Handled> {
  const { requestId, reviewId, inputPath } = parsed.crew;
  if (requestId === undefined || reviewId === undefined || inputPath === undefined) {
    return "invalid-arguments";
  }

  const reference = await readWorktreeReference({
    parsed,
    operation: "review_report",
    expectedAttemptId: parsed.crew.attemptId ?? null,
  });
  if (reference === null) {
    return "reported";
  }

  const read = await readStructuredInput(inputPath);
  if (!read.ok) {
    report({
      json: parsed.json,
      result: {
        outcome: "invalid",
        reason: "invalid_review_report",
        blockers: [{ reason: "invalid_review_report", detail: read.detail }],
        operation: "review_report",
      },
      lines: [`The review report cannot be read: ${read.detail}`],
    });
    return "reported";
  }

  const { repeated, result } = await CrewState.report({
    projectRoot: reference.controllingCheckout,
    requestId,
    reviewId,
    attemptId: reference.attemptId,
    worktreePath: reference.worktreePath,
    input: read.value,
  });

  if (reportSharedFailure(parsed, "review_report", result)) {
    return "reported";
  }

  if (result.status === "invalid-input") {
    report({
      json: parsed.json,
      result: {
        outcome: "invalid",
        reason: "invalid_review_report",
        blockers: result.issues.map((issue) => ({
          reason: "invalid_review_report" as const,
          issue,
        })),
        operation: "review_report",
      },
      lines: ["The review report is not valid:", ...result.issues.map((one) => `  ${one}`)],
    });
    return "reported";
  }

  if (result.status === "reference-mismatch") {
    report({
      json: parsed.json,
      result: {
        outcome: "conflict",
        reason: "attempt_reference_mismatch",
        blockers: [{ reason: "attempt_reference_mismatch", detail: result.detail }],
        operation: "review_report",
      },
      lines: [result.detail],
    });
    return "reported";
  }

  if (result.status === "worktree-changed") {
    report({
      json: parsed.json,
      result: {
        outcome: "conflict",
        reason: "review_worktree_changed",
        blockers: [
          ...result.changes.map((path) => ({ reason: "review_worktree_changed" as const, path })),
          ...result.commits.map((commit) => ({
            reason: "review_worktree_changed" as const,
            commit,
          })),
        ],
        operation: "review_report",
        data: { attemptId: result.attemptId },
      },
      lines: [
        "This review changed its own checkout, so its report is refused:",
        ...result.changes.map((path) => `  changed ${path}`),
        ...result.commits.map((commit) => `  committed ${commit}`),
        "A review reads and runs checks. Rework is a separate assignment for a fresh Operative.",
      ],
    });
    return "reported";
  }

  if (result.status === "review-not-assigned") {
    report({
      json: parsed.json,
      result: {
        outcome: "conflict",
        reason: "review_not_assigned",
        blockers: [
          {
            reason: "review_not_assigned",
            reviewId: result.reviewId,
            assignmentId: result.assignmentId,
          },
        ],
        operation: "review_report",
      },
      lines: [`Review ${result.reviewId} belongs to assignment ${result.assignmentId}.`],
    });
    return "reported";
  }

  if (result.status === "review-settled") {
    report({
      json: parsed.json,
      result: {
        outcome: "conflict",
        reason: "review_settled",
        blockers: [{ reason: "review_settled", reviewId: result.reviewId, state: result.state }],
        operation: "review_report",
      },
      lines: [`Review ${result.reviewId} is already ${result.state}, so it takes no new report.`],
    });
    return "reported";
  }

  if (result.status === "submission-drift") {
    report({
      json: parsed.json,
      result: {
        outcome: "conflict",
        reason: "submission_drift",
        blockers: [
          {
            reason: "submission_drift",
            reviewId: result.reviewId,
            recorded: result.recorded,
            stated: result.stated,
          },
        ],
        operation: "review_report",
      },
      lines: [
        "This report names a different submission than the one under review.",
        `The review reads submission identity ${result.recorded}.`,
      ],
    });
    return "reported";
  }

  if (result.status === "axes-incomplete") {
    report({
      json: parsed.json,
      result: {
        outcome: "missing-condition",
        reason: "review_axes_incomplete",
        blockers: result.missing.map((axis) => ({
          reason: "review_axes_incomplete" as const,
          axis,
        })),
        operation: "review_report",
        data: { reviewId: result.reviewId },
      },
      lines: [
        `Each axis is reported exactly once. These are not: ${result.missing.join(", ")}.`,
        "A partial review accepts nothing.",
      ],
    });
    return "reported";
  }

  if (result.status === "axes-not-parallel") {
    report({
      json: parsed.json,
      result: {
        outcome: "conflict",
        reason: "review_axes_not_parallel",
        blockers: result.windows.map((one) => ({
          reason: "review_axes_not_parallel" as const,
          ...one,
        })),
        operation: "review_report",
        data: { reviewId: result.reviewId },
      },
      lines: [
        "The two axes ran one after the other, so they were not separate parallel contexts.",
        ...result.windows.map((one) => `  ${one.axis}: ${one.startedAt} to ${one.endedAt}`),
      ],
    });
    return "reported";
  }

  if (result.status === "host-mismatch") {
    report({
      json: parsed.json,
      result: {
        outcome: "conflict",
        reason: "review_host_mismatch",
        blockers: [
          { reason: "review_host_mismatch", host: result.stated, recorded: result.recorded },
        ],
        operation: "review_report",
        data: { reviewId: result.reviewId },
      },
      lines: [
        `This reviewer was launched on ${result.recorded}, and the report names ${result.stated}.`,
        "A review reports the host it actually ran on.",
      ],
    });
    return "reported";
  }

  if (result.status === "sub-agent-host-mismatch") {
    report({
      json: parsed.json,
      result: {
        outcome: "conflict",
        reason: "review_sub_agent_host_mismatch",
        blockers: result.stated.map((host) => ({
          reason: "review_sub_agent_host_mismatch" as const,
          host,
          recorded: result.recorded,
        })),
        operation: "review_report",
        data: { reviewId: result.reviewId },
      },
      lines: [
        `This reviewer runs on ${result.recorded}, so its sub-agents are native to that host.`,
        "A review sub-agent never takes a Herdr crew slot of its own.",
      ],
    });
    return "reported";
  }

  if (result.status === "sub-agent-failed") {
    report({
      json: parsed.json,
      result: {
        outcome: "failed",
        reason: "review_sub_agent_failed",
        blockers: result.axes.map((axis) => ({ reason: "review_sub_agent_failed" as const, axis })),
        operation: "review_report",
        data: { reviewId: result.reviewId },
      },
      lines: [
        `These axes did not complete: ${result.axes.join(", ")}.`,
        "Record the blocker instead, or run the review again.",
      ],
    });
    return "reported";
  }

  if (result.status === "coverage-incomplete") {
    report({
      json: parsed.json,
      result: {
        outcome: "missing-condition",
        reason: "review_coverage_incomplete",
        blockers: result.gaps.map((gap) => ({
          reason: "review_coverage_incomplete" as const,
          ...gap,
        })),
        operation: "review_report",
        data: { reviewId: result.reviewId },
      },
      lines: [
        "Each axis states what it read, and these inputs were not covered:",
        ...result.gaps.map((gap) => `  ${gap.axis}: ${gap.missing.join(", ")}`),
      ],
    });
    return "reported";
  }

  if (result.status === "blocked") {
    report({
      json: parsed.json,
      result: {
        outcome: "missing-condition",
        reason: "review_blocked",
        blockers: [{ reason: "review_blocked", detail: result.detail, blocker: result.reason }],
        operation: "review_report",
        data: {
          reviewId: result.reviewId,
          assignmentId: result.assignmentId,
          reason: result.reason,
          repeated,
        },
      },
      lines: [
        `Review ${result.reviewId} is blocked: ${result.reason}.`,
        result.detail,
        "A blocked review accepts nothing. Bring the blocker to the user.",
      ],
    });
    return "reported";
  }

  const blockers = result.findings.filter((one) => one.severity === "blocker");
  report({
    json: parsed.json,
    result: {
      outcome: "completed",
      reason: "review_reported",
      blockers: [],
      operation: "review_report",
      data: {
        reviewId: result.reviewId,
        assignmentId: result.assignmentId,
        submissionId: result.submissionId,
        findings: result.findings,
        repeated,
      },
    },
    lines: [
      `Recorded both axis reports for review ${result.reviewId}.`,
      `${result.findings.length} finding(s), ${blockers.length} of them blockers.`,
      ...result.findings.map(
        (one) => `  ${one.findingId} ${one.axis} ${one.severity} ${one.summary}`,
      ),
      "Every finding needs a disposition before the result can be accepted.",
    ],
  });
  return "reported";
}

async function runDispose(parsed: ParsedArguments): Promise<Handled> {
  const { requestId, ownerToken, reviewId, inputPath } = parsed.crew;
  if (
    requestId === undefined ||
    ownerToken === undefined ||
    reviewId === undefined ||
    inputPath === undefined
  ) {
    return "invalid-arguments";
  }

  const read = await readStructuredInput(inputPath);
  if (!read.ok) {
    report({
      json: parsed.json,
      result: {
        outcome: "invalid",
        reason: "invalid_disposition_input",
        blockers: [{ reason: "invalid_disposition_input", detail: read.detail }],
        operation: "review_dispose",
      },
      lines: [`The dispositions cannot be read: ${read.detail}`],
    });
    return "reported";
  }

  const { repeated, result } = await CrewState.dispose({
    projectRoot: process.cwd(),
    requestId,
    ownerToken,
    reviewId,
    input: read.value,
  });

  if (reportSharedFailure(parsed, "review_dispose", result)) {
    return "reported";
  }

  if (result.status === "invalid-input") {
    report({
      json: parsed.json,
      result: {
        outcome: "invalid",
        reason: "invalid_disposition_input",
        blockers: result.issues.map((issue) => ({
          reason: "invalid_disposition_input" as const,
          issue,
        })),
        operation: "review_dispose",
      },
      lines: ["The dispositions are not valid:", ...result.issues.map((one) => `  ${one}`)],
    });
    return "reported";
  }

  if (result.status === "review-not-reported") {
    report({
      json: parsed.json,
      result: {
        outcome: "missing-condition",
        reason: "review_not_reported",
        blockers: [
          { reason: "review_not_reported", reviewId: result.reviewId, state: result.state },
        ],
        operation: "review_dispose",
      },
      lines: [`Review ${result.reviewId} is ${result.state}, so it carries no findings yet.`],
    });
    return "reported";
  }

  if (result.status === "unknown-finding") {
    report({
      json: parsed.json,
      result: {
        outcome: "invalid",
        reason: "unknown_finding",
        blockers: result.findingIds.map((findingId) => ({
          reason: "unknown_finding" as const,
          findingId,
        })),
        operation: "review_dispose",
      },
      lines: [`Review ${result.reviewId} holds no such finding(s).`],
    });
    return "reported";
  }

  if (result.status === "blocker-not-deferrable") {
    report({
      json: parsed.json,
      result: {
        outcome: "invalid",
        reason: "blocker_not_deferrable",
        blockers: result.findingIds.map((findingId) => ({
          reason: "blocker_not_deferrable" as const,
          findingId,
        })),
        operation: "review_dispose",
      },
      lines: [
        "A blocker is corrected or rejected with a reason. It is never deferred.",
        "Technical judgment does not waive an approved requirement.",
      ],
    });
    return "reported";
  }

  report({
    json: parsed.json,
    result: {
      // A finding with no disposition, and an accepted correction that has no rework yet, both
      // leave work between this review and acceptance.
      outcome:
        result.outstanding.length === 0 && result.corrections.length === 0
          ? "completed"
          : "pending",
      reason: "findings_disposed",
      blockers: result.outstanding.map((findingId) => ({
        reason: "findings_undisposed" as const,
        findingId,
      })),
      operation: "review_dispose",
      data: {
        reviewId: result.reviewId,
        disposed: result.disposed,
        outstanding: result.outstanding,
        corrections: result.corrections,
        repeated,
      },
    },
    lines: [
      `Recorded ${result.disposed.length} disposition(s) on review ${result.reviewId}.`,
      ...(result.outstanding.length === 0
        ? ["Every finding now carries a disposition."]
        : [`${result.outstanding.length} finding(s) still carry none.`]),
      ...(result.corrections.length === 0
        ? []
        : [
            `${result.corrections.length} correction(s) wait for a fresh Operative.`,
            "Acceptance stays blocked until that rework lands.",
          ]),
    ],
  });
  return "reported";
}

async function runShow(parsed: ParsedArguments): Promise<Handled> {
  const reviewId = parsed.crew.reviewId;
  if (reviewId === undefined) {
    return "invalid-arguments";
  }

  const { result } = await CrewState.review({ projectRoot: process.cwd(), reviewId });
  if (reportSharedFailure(parsed, "review_show", result)) {
    return "reported";
  }

  if (result.status === "submission-missing") {
    report({
      json: parsed.json,
      result: {
        outcome: "conflict",
        reason: "review_submission_missing",
        blockers: [
          {
            reason: "review_submission_missing",
            reviewId: result.reviewId,
            submissionId: result.submissionId,
          },
        ],
        operation: "review_show",
      },
      lines: [
        `Review ${result.reviewId} names submission ${result.submissionId}, which the crew state does not hold.`,
      ],
    });
    return "reported";
  }

  report({
    json: parsed.json,
    result: {
      outcome: "completed",
      reason: "review_shown",
      blockers: [],
      operation: "review_show",
      data: result,
    },
    lines: [
      `Review ${result.review.id} of submission ${result.submission.id} is ${result.review.state}.`,
      `Result kind ${result.submission.resultKind}, host ${result.review.host ?? "none"}.`,
      ...result.reports.map(
        (one) => `  ${one.axis}: ${one.findingCount} finding(s), ${one.summary}`,
      ),
      ...(result.missingAxes.length === 0
        ? []
        : [`Missing axes: ${result.missingAxes.join(", ")}.`]),
      ...result.findings.map(
        (one) =>
          `  ${one.findingId} ${one.axis} ${one.severity} ${one.disposition ?? "undisposed"} ${one.summary}`,
      ),
    ],
  });
  return "reported";
}

export async function runReview(words: string[], parsed: ParsedArguments): Promise<Handled> {
  if (words.length !== 1) {
    return "invalid-arguments";
  }

  const [subcommand] = words;
  if (subcommand === "report") {
    return runReport(parsed);
  }
  if (subcommand === "dispose") {
    return runDispose(parsed);
  }
  if (subcommand === "show") {
    return runShow(parsed);
  }

  return "invalid-arguments";
}
