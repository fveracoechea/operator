import { CrewState } from "../crew-state/main.ts";
import type { ParsedArguments } from "./arguments.ts";
import {
  invalidInputRefusals,
  readFindings,
  readStructuredInput,
  reportSharedFailure,
} from "./crew-result.ts";
import { requireReference } from "./reference.ts";
import {
  answer,
  countedBlockers,
  type Handled,
  type Refusal,
  type Refusals,
  refuse,
  report,
} from "./result.ts";

type ReportResult = Awaited<ReturnType<typeof CrewState.report>>["result"];
type DisposeResult = Awaited<ReturnType<typeof CrewState.dispose>>["result"];

/** The refusal of a report that changes nothing, with one blocker under its reason. */
function drift(kind: "submission" | "branch snapshot") {
  return (result: { reviewId: string; recorded: string; stated: string }): Refusal => ({
    outcome: "conflict",
    reason: kind === "submission" ? "submission_drift" : "snapshot_drift",
    detail: { reviewId: result.reviewId, recorded: result.recorded, stated: result.stated },
    lines: [
      `This report names a different ${kind} than the one under review.`,
      `The review reads ${kind === "submission" ? "submission" : "snapshot"} identity ${result.recorded}.`,
    ],
  });
}

/** The answers of `review report` to every status that records no report. */
function reportRefusals(repeated: boolean) {
  return {
    ...invalidInputRefusals("invalid_review_report"),
    "reference-mismatch": (result) => ({
      outcome: "conflict",
      reason: "attempt_reference_mismatch",
      detail: { detail: result.detail },
      lines: [result.detail],
    }),
    "worktree-changed": (result) => ({
      outcome: "conflict",
      reason: "review_worktree_changed",
      blockers: [
        ...result.changes.map((path) => ({ reason: "review_worktree_changed" as const, path })),
        ...result.commits.map((commit) => ({ reason: "review_worktree_changed" as const, commit })),
      ],
      data: { attemptId: result.attemptId },
      lines: [
        "This review changed its own checkout, so its report is refused:",
        ...result.changes.map((path) => `  changed ${path}`),
        ...result.commits.map((commit) => `  committed ${commit}`),
        "A review reads and runs checks. Rework is a separate assignment for a fresh Operative.",
      ],
    }),
    "review-not-assigned": (result) => ({
      outcome: "conflict",
      reason: "review_not_assigned",
      detail: { reviewId: result.reviewId, assignmentId: result.assignmentId },
      lines: [`Review ${result.reviewId} belongs to assignment ${result.assignmentId}.`],
    }),
    "review-settled": (result) => ({
      outcome: "conflict",
      reason: "review_settled",
      detail: { reviewId: result.reviewId, state: result.state },
      lines: [`Review ${result.reviewId} is already ${result.state}, so it takes no new report.`],
    }),
    "submission-drift": drift("submission"),
    "snapshot-drift": drift("branch snapshot"),
    // The findings of a refused report are not recorded, so the reviewer reads them here.
    "finding-untargeted": (result) => ({
      outcome: "missing-condition",
      reason: "review_finding_untargeted",
      blockers: result.findings.map((one) => ({
        reason: "review_finding_untargeted" as const,
        ...one,
      })),
      data: { reviewId: result.reviewId },
      lines: [
        "Each branch finding names the commits it targets. These name none:",
        ...result.findings.map((one) => `  ${one.axis} ${one.key}`),
      ],
    }),
    "cut-not-between-commits": (result) => ({
      outcome: "conflict",
      reason: "review_cut_not_between_commits",
      detail: { cuts: result.cuts, detail: result.detail },
      data: { reviewId: result.reviewId },
      lines: [result.detail],
    }),
    "finding-target-unknown": (result) => ({
      outcome: "conflict",
      reason: "review_finding_target_unknown",
      blockers: result.findings.map((one) => ({
        reason: "review_finding_target_unknown" as const,
        ...one,
      })),
      data: { reviewId: result.reviewId },
      lines: [
        "Each target is a commit of the branch snapshot. These are not:",
        ...result.findings.map((one) => `  ${one.axis} ${one.key}: ${one.targets.join(", ")}`),
      ],
    }),
    "axes-incomplete": (result) => ({
      outcome: "missing-condition",
      reason: "review_axes_incomplete",
      blockers: result.missing.map((axis) => ({ reason: "review_axes_incomplete" as const, axis })),
      data: { reviewId: result.reviewId },
      lines: [
        `Each axis is reported exactly once. These are not: ${result.missing.join(", ")}.`,
        "A partial review accepts nothing.",
      ],
    }),
    "axes-not-parallel": (result) => ({
      outcome: "conflict",
      reason: "review_axes_not_parallel",
      blockers: result.windows.map((one) => ({
        reason: "review_axes_not_parallel" as const,
        ...one,
      })),
      data: { reviewId: result.reviewId },
      lines: [
        "The two axes ran one after the other, so they were not separate parallel contexts.",
        ...result.windows.map((one) => `  ${one.axis}: ${one.startedAt} to ${one.endedAt}`),
      ],
    }),
    "host-mismatch": (result) => ({
      outcome: "conflict",
      reason: "review_host_mismatch",
      detail: { host: result.stated, recorded: result.recorded },
      data: { reviewId: result.reviewId },
      lines: [
        `This reviewer was launched on ${result.recorded}, and the report names ${result.stated}.`,
        "A review reports the host it actually ran on.",
      ],
    }),
    "sub-agent-host-mismatch": (result) => ({
      outcome: "conflict",
      reason: "review_sub_agent_host_mismatch",
      blockers: result.stated.map((host) => ({
        reason: "review_sub_agent_host_mismatch" as const,
        host,
        recorded: result.recorded,
      })),
      data: { reviewId: result.reviewId },
      lines: [
        `This reviewer runs on ${result.recorded}, so its sub-agents are native to that host.`,
        "A review sub-agent never takes a Herdr crew slot of its own.",
      ],
    }),
    "sub-agent-failed": (result) => ({
      outcome: "failed",
      reason: "review_sub_agent_failed",
      blockers: result.axes.map((axis) => ({ reason: "review_sub_agent_failed" as const, axis })),
      data: { reviewId: result.reviewId },
      lines: [
        `These axes did not complete: ${result.axes.join(", ")}.`,
        "Record the blocker instead, or run the review again.",
      ],
    }),
    "coverage-incomplete": (result) => ({
      outcome: "missing-condition",
      reason: "review_coverage_incomplete",
      blockers: result.gaps.map((gap) => ({
        reason: "review_coverage_incomplete" as const,
        ...gap,
      })),
      data: { reviewId: result.reviewId },
      lines: [
        "Each axis states what it read, and these inputs were not covered:",
        ...result.gaps.map((gap) => `  ${gap.axis}: ${gap.missing.join(", ")}`),
      ],
    }),
    "published-text-missing": (result) => ({
      outcome: "missing-condition",
      reason: "review_published_text_missing",
      detail: { reviewId: result.reviewId },
      lines: [
        "This result is the only code result of its source, so its review writes the pull request text.",
        "Add `published` with the title, the summary, where to start reading, and the merge danger.",
      ],
    }),
    blocked: (result) => ({
      outcome: "missing-condition",
      reason: "review_blocked",
      detail: { detail: result.detail, blocker: result.reason },
      data: {
        reviewId: result.reviewId,
        assignmentId: result.assignmentId,
        reason: result.reason,
        repeated,
      },
      lines: [
        `Review ${result.reviewId} is blocked: ${result.reason}.`,
        result.detail,
        "A blocked review accepts nothing. Bring the blocker to the user.",
      ],
    }),
  } satisfies Refusals<ReportResult>;
}

async function runReport(parsed: ParsedArguments): Promise<Handled> {
  const { requestId, reviewId, inputPath } = parsed.crew;
  if (requestId === undefined || reviewId === undefined || inputPath === undefined) {
    return "invalid-arguments";
  }

  const located = await requireReference({
    parsed,
    operation: "review_report",
    expectedAttemptId: parsed.crew.attemptId ?? null,
  });
  if (located.status !== "read") {
    return "reported";
  }

  const reference = located.reference;
  const read = await readStructuredInput({
    parsed,
    operation: "review_report",
    reason: "invalid_review_report",
    path: inputPath,
  });
  if (read.status !== "read") {
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

  if (answer(parsed, "review_report", result, reportRefusals(repeated))) {
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
        snapshotId: result.snapshotId,
        findings: result.findings,
        repeated,
      },
    },
    lines: [
      `Recorded both axis reports for review ${result.reviewId}.`,
      `${result.findings.length} finding(s), ${blockers.length} of them blockers.`,
      ...(result.findings.length === 0 ? [] : [readFindings(result.reviewId)]),
      result.snapshotId === null
        ? "Every finding needs a disposition before the result can be accepted."
        : "Every finding needs a disposition before the branch can be published.",
    ],
  });
  return "reported";
}

/**
 * The refusal of a disposition that names findings. One blocker counts them, and the ids stay
 * in `data` (R5).
 */
function findingsRefused(
  reason: "unknown_finding" | "blocker_not_deferrable" | "correction_target_not_expected",
  lines: (reviewId: string) => string[],
) {
  return (result: { reviewId: string; findingIds: string[] }): Refusal => ({
    outcome: "invalid",
    reason,
    blockers: countedBlockers(reason, result.findingIds),
    data: { reviewId: result.reviewId, findingIds: result.findingIds },
    lines: lines(result.reviewId),
  });
}

/** The answers of `review dispose` to every status that records no disposition. */
const disposeRefusals = {
  ...invalidInputRefusals("invalid_disposition_input"),
  "review-not-reported": (result) => ({
    outcome: "missing-condition",
    reason: "review_not_reported",
    detail: { reviewId: result.reviewId, state: result.state },
    lines: [`Review ${result.reviewId} is ${result.state}, so it carries no findings yet.`],
  }),
  "unknown-finding": findingsRefused("unknown_finding", (reviewId) => [
    `Review ${reviewId} holds no such finding(s).`,
  ]),
  "blocker-not-deferrable": findingsRefused("blocker_not_deferrable", () => [
    "A blocker is corrected, or rejected with a reason and the evidence. It is never deferred.",
    "Technical judgment does not waive an approved requirement.",
  ]),
  "correction-target-required": (result) => ({
    outcome: "invalid",
    reason: "correction_target_required",
    blockers: countedBlockers("correction_target_required", result.findingIds),
    data: { reviewId: result.reviewId, findingIds: result.findingIds },
    lines: [
      "A corrected branch finding names in `target` the one assignment it invalidates.",
      `${result.findingIds.length} finding(s) of review ${result.reviewId} name none. ${readFindings(result.reviewId)}`,
    ],
  }),
  "correction-target-not-expected": findingsRefused(
    "correction_target_not_expected",
    (reviewId) => [
      `Review ${reviewId} reads one submission, so its corrections name no target.`,
      "Only a corrected branch finding names the assignment it invalidates.",
    ],
  ),
  "correction-target-unknown": (result) => ({
    outcome: "invalid",
    reason: "correction_target_unknown",
    blockers: countedBlockers("correction_target_unknown", result.findings),
    data: { reviewId: result.reviewId, findings: result.findings },
    lines: [
      "The target of a corrected branch finding holds one of the commits the finding targets.",
      `${result.findings.length} finding(s) of review ${result.reviewId} name another target. ${readFindings(result.reviewId)}`,
    ],
  }),
} satisfies Refusals<DisposeResult>;

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

  const read = await readStructuredInput({
    parsed,
    operation: "review_dispose",
    reason: "invalid_disposition_input",
    path: inputPath,
  });
  if (read.status !== "read") {
    return "reported";
  }

  const { repeated, result } = await CrewState.dispose({
    projectRoot: process.cwd(),
    requestId,
    ownerToken,
    reviewId,
    input: read.value,
  });

  if (answer(parsed, "review_dispose", result, disposeRefusals)) {
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
      blockers: countedBlockers("findings_undisposed", result.outstanding),
      operation: "review_dispose",
      data: {
        reviewId: result.reviewId,
        disposed: result.disposed,
        outstanding: result.outstanding,
        corrections: result.corrections,
        invalidated: result.invalidated,
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
      ...result.invalidated.map(
        (one) =>
          `Invalidated ${one.assignmentId} in ${one.invalidationId}, pausing ${one.dependents.length} dependent(s). Its correction runs in an invalidation cycle.`,
      ),
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
    return refuse({
      json: parsed.json,
      operation: "review_show",
      outcome: "conflict",
      reason: "review_submission_missing",
      detail: {
        reviewId: result.reviewId,
        submissionId: result.submissionId,
      },
      lines: [
        `Review ${result.reviewId} names submission ${result.submissionId}, which the crew state does not hold.`,
      ],
    });
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
      result.submission === null
        ? `Branch review ${result.review.id} of snapshot ${result.snapshot?.id ?? "unknown"} at head ${result.snapshot?.headCommit ?? "unknown"} is ${result.review.state}.`
        : `Review ${result.review.id} of submission ${result.submission.id} is ${result.review.state}.`,
      `Result kind ${result.submission?.resultKind ?? "code"}, host ${result.review.host ?? "none"}.`,
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
      ...(result.submission === null || result.submission.outsideChanges.length === 0
        ? []
        : [
            `Outside changes of submission ${result.submission.id}:`,
            ...result.submission.outsideChanges.map(
              (one) =>
                `  ${one.changeId} ${one.place} ${one.change}${one.security ? " security" : ""} ${one.disposition ?? "undisposed"} ${one.path}`,
            ),
          ]),
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
