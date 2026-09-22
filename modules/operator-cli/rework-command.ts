import { CrewState } from "../crew-state/main.ts";
import { type ParsedArguments, readAssignmentRequest } from "./arguments.ts";
import {
  readStructuredInput,
  reportAssignmentFailure,
  reportInvalidInput,
  reportSharedFailure,
} from "./crew-result.ts";
import { type Handled, refuse, report } from "./result.ts";

export async function runRework(parsed: ParsedArguments): Promise<Handled> {
  const request = readAssignmentRequest(parsed);
  if (request === null) {
    return "invalid-arguments";
  }

  const read = await readStructuredInput({
    parsed,
    operation: "work_rework",
    reason: "invalid_rework_input",
    path: request.inputPath,
  });
  if (read.status !== "read") {
    return "reported";
  }

  const { repeated, result } = await CrewState.rework({
    projectRoot: process.cwd(),
    requestId: request.requestId,
    ownerToken: request.ownerToken,
    assignmentId: request.assignmentId,
    revision: request.revision,
    input: read.value,
  });

  if (
    reportSharedFailure(parsed, "work_rework", result) ||
    reportAssignmentFailure(parsed, "work_rework", result)
  ) {
    return "reported";
  }

  if (result.status === "invalid-input") {
    return reportInvalidInput({
      parsed,
      operation: "work_rework",
      reason: "invalid_rework_input",
      issues: result.issues,
    });
  }

  if (result.status === "not-awaiting-review") {
    return refuse({
      json: parsed.json,
      operation: "work_rework",
      outcome: "conflict",
      reason: "assignment_not_awaiting_review",
      detail: { assignmentId: result.assignmentId, state: result.state },
      lines: [
        `Assignment ${result.assignmentId} is ${result.state}, so it holds no result to rework.`,
        "One cycle answers one submitted result.",
      ],
    });
  }

  if (result.status === "submission-required") {
    return refuse({
      json: parsed.json,
      operation: "work_rework",
      outcome: "missing-condition",
      reason: "submission_required",
      detail: { assignmentId: result.assignmentId },
      lines: [`Assignment ${result.assignmentId} has no submitted result to rework.`],
    });
  }

  if (result.status === "cycle-open") {
    return refuse({
      json: parsed.json,
      operation: "work_rework",
      outcome: "conflict",
      reason: "rework_cycle_open",
      detail: {
        assignmentId: result.assignmentId,
        cycleId: result.cycleId,
        reason: result.reason,
      },
      lines: [
        `Cycle ${result.cycleId} (${result.reason}) is still open on ${result.assignmentId}.`,
        "One combined revision answers every accepted correction at once.",
      ],
    });
  }

  if (result.status === "review-not-of-submission") {
    return refuse({
      json: parsed.json,
      operation: "work_rework",
      outcome: "conflict",
      reason: "review_not_of_submission",
      detail: { reviewId: result.reviewId, submissionId: result.submissionId },
      lines: [
        `Review ${result.reviewId} does not read submission ${result.submissionId}.`,
        "Rework answers the review of the result it is about to change.",
      ],
    });
  }

  if (result.status === "review-not-reported") {
    return refuse({
      json: parsed.json,
      operation: "work_rework",
      outcome: "missing-condition",
      reason: "review_not_reported",
      detail: { reviewId: result.reviewId, state: result.state },
      lines: [`Review ${result.reviewId} is ${result.state}, so it carries no findings yet.`],
    });
  }

  if (result.status === "findings-undisposed") {
    report({
      json: parsed.json,
      result: {
        outcome: "missing-condition",
        reason: "findings_undisposed",
        blockers: result.findingIds.map((findingId) => ({
          reason: "findings_undisposed" as const,
          findingId,
          reviewId: result.reviewId,
        })),
        operation: "work_rework",
      },
      lines: [
        `${result.findingIds.length} finding(s) of review ${result.reviewId} carry no disposition.`,
        "Every finding is answered before any of them is delegated.",
      ],
    });
    return "reported";
  }

  if (result.status === "no-corrections") {
    return refuse({
      json: parsed.json,
      operation: "work_rework",
      outcome: "invalid",
      reason: "no_corrections",
      detail: { reviewId: result.reviewId },
      lines: [
        `Review ${result.reviewId} holds no finding the Operator accepted for correction.`,
        "A rejected or deferred finding is already answered, so it delegates nothing.",
      ],
    });
  }

  if (result.status === "conflict-not-corrected") {
    report({
      json: parsed.json,
      result: {
        outcome: "invalid",
        reason: "conflict_not_corrected",
        blockers: result.findingIds.map((findingId) => ({
          reason: "conflict_not_corrected" as const,
          findingId,
          reviewId: result.reviewId,
        })),
        operation: "work_rework",
      },
      lines: [
        "A conflict names work this cycle carries, and these findings are not corrections:",
        ...result.findingIds.map((findingId) => `  ${findingId}`),
      ],
    });
    return "reported";
  }

  if (result.status === "unknown-check" || result.status === "checks-passed") {
    const unknown = result.status === "unknown-check";
    report({
      json: parsed.json,
      result: {
        outcome: "invalid",
        reason: unknown ? "unknown_check" : "checks_passed",
        blockers: result.names.map((name) => ({
          reason: unknown ? ("unknown_check" as const) : ("checks_passed" as const),
          name,
        })),
        operation: "work_rework",
        data: { assignmentId: result.assignmentId },
      },
      lines: [
        unknown
          ? `The submission records no check named: ${result.names.join(", ")}.`
          : `These checks passed, so there is nothing to diagnose: ${result.names.join(", ")}.`,
      ],
    });
    return "reported";
  }

  if (result.status === "limit-reached") {
    const { direction } = result;
    report({
      json: parsed.json,
      result: {
        outcome: "missing-condition",
        reason: "limit_reached",
        blockers: [
          {
            reason: "limit_reached",
            assignmentId: result.assignmentId,
            limitKind: result.limitKind,
            limit: result.limit,
            used: result.used,
            approval: result.approval,
          },
        ],
        operation: "work_rework",
        data: { direction, repeated },
      },
      lines: [
        `Assignment ${result.assignmentId} used its ${result.limit} ${result.limitKind}.`,
        `Direction request ${direction.directionRequestId} is open at revision ${direction.revision}.`,
        "Nothing was deleted. Bring the recorded evidence to the user, and record their direction:",
        "  operator approval grant --request <id> --owner-token <token> --input <path>",
        `  with action "${direction.approval.action}", scope "${direction.approval.scope}", and requestRevision "${direction.approval.requestRevision}".`,
      ],
    });
    return "reported";
  }

  report({
    json: parsed.json,
    result: {
      outcome: "completed",
      reason: "rework_delegated",
      blockers: [],
      operation: "work_rework",
      data: {
        cycleId: result.cycleId,
        assignmentId: result.assignmentId,
        revision: result.revision,
        reason: result.reason,
        cycleIndex: result.cycleIndex,
        limit: result.limit,
        submissionId: result.submissionId,
        reviewId: result.reviewId,
        corrections: result.corrections,
        conflicts: result.conflicts,
        briefIdentity: result.briefIdentity,
        approvalId: result.approvalId,
        repeated,
      },
    },
    lines: [
      `Delegated ${result.reason} cycle ${result.cycleIndex} of ${result.limit} on ${result.assignmentId}.`,
      `${result.corrections.length} accepted correction(s) and ${result.conflicts} conflict(s) go to a fresh Operative.`,
      "Claim the assignment again and dispatch it from the submitted commit.",
    ],
  });
  return "reported";
}
