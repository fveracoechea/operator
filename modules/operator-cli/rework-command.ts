import { CrewState } from "../crew-state/main.ts";
import { type ParsedArguments, readAssignmentRequest } from "./arguments.ts";
import {
  assignmentRefusals,
  invalidInputRefusals,
  landingRefusals,
  readStructuredInput,
} from "./crew-result.ts";
import { answer, type Handled, type Refusals, report } from "./result.ts";

type ReworkResult = Awaited<ReturnType<typeof CrewState.rework>>["result"];

/** Every rework that delegates nothing. Nothing was recorded, and no Operative was started. */
const reworkRefusals = {
  ...assignmentRefusals,
  ...invalidInputRefusals("invalid_rework_input"),
  "not-awaiting-review": (result) => ({
    outcome: "conflict",
    reason: "assignment_not_awaiting_review",
    detail: { assignmentId: result.assignmentId, state: result.state },
    lines: [
      `Assignment ${result.assignmentId} is ${result.state}, so it holds no result to rework.`,
      "One cycle answers one submitted result.",
    ],
  }),
  "submission-required": (result) => ({
    outcome: "missing-condition",
    reason: "submission_required",
    detail: { assignmentId: result.assignmentId },
    lines: [`Assignment ${result.assignmentId} has no submitted result to rework.`],
  }),
  "cycle-open": (result) => ({
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
  }),
  "review-not-of-submission": (result) => ({
    outcome: "conflict",
    reason: "review_not_of_submission",
    detail: { reviewId: result.reviewId, submissionId: result.submissionId },
    lines: [
      `Review ${result.reviewId} does not read submission ${result.submissionId}.`,
      "Rework answers the review of the result it is about to change.",
    ],
  }),
  "review-not-reported": (result) => ({
    outcome: "missing-condition",
    reason: "review_not_reported",
    detail: { reviewId: result.reviewId, state: result.state },
    lines: [`Review ${result.reviewId} is ${result.state}, so it carries no findings yet.`],
  }),
  "findings-undisposed": (result) => ({
    outcome: "missing-condition",
    reason: "findings_undisposed",
    blockers: result.findingIds.map((findingId) => ({
      reason: "findings_undisposed" as const,
      findingId,
      reviewId: result.reviewId,
    })),
    lines: [
      `${result.findingIds.length} finding(s) of review ${result.reviewId} carry no disposition.`,
      "Every finding is answered before any of them is delegated.",
    ],
  }),
  "no-corrections": (result) => ({
    outcome: "invalid",
    reason: "no_corrections",
    detail: { reviewId: result.reviewId },
    lines: [
      `Review ${result.reviewId} holds no finding the Operator accepted for correction.`,
      "A rejected or deferred finding is already answered, so it delegates nothing.",
    ],
  }),
  "conflict-not-corrected": (result) => ({
    outcome: "invalid",
    reason: "conflict_not_corrected",
    blockers: result.findingIds.map((findingId) => ({
      reason: "conflict_not_corrected" as const,
      findingId,
      reviewId: result.reviewId,
    })),
    lines: [
      "A conflict names work this cycle carries, and these findings are not corrections:",
      ...result.findingIds.map((findingId) => `  ${findingId}`),
    ],
  }),
  "unknown-check": (result) => ({
    outcome: "invalid",
    reason: "unknown_check",
    blockers: result.names.map((name) => ({ reason: "unknown_check" as const, name })),
    data: { assignmentId: result.assignmentId },
    lines: [`The submission records no check named: ${result.names.join(", ")}.`],
  }),
  "checks-passed": (result) => ({
    outcome: "invalid",
    reason: "checks_passed",
    blockers: result.names.map((name) => ({ reason: "checks_passed" as const, name })),
    data: { assignmentId: result.assignmentId },
    lines: [`These checks passed, so there is nothing to diagnose: ${result.names.join(", ")}.`],
  }),
  ...landingRefusals({
    retry: "delegate the cycle",
    gateCommand: "operator gate run --assignment <id>",
    nothing: "No cycle was delegated.",
  }),
  "lands-cleanly": (result) => ({
    outcome: "conflict",
    reason: "lands_cleanly",
    detail: {
      assignmentId: result.assignmentId,
      branch: result.branch,
      tip: result.tip,
      planned: result.planned,
    },
    lines: [
      `The submitted result lands cleanly on ${result.tip} of ${result.branch} as ${result.planned}, and no failed or flaky gate run is recorded at that commit.`,
      "It needs no integration cycle. Read `operator crew next` for the step it owes.",
    ],
  }),
  "no-landing": (result) => ({
    outcome: "conflict",
    reason: "no_landing",
    detail: { assignmentId: result.assignmentId, submissionId: result.submissionId },
    lines: [
      `Submission ${result.submissionId} holds no commit, so it lands nothing and has nothing to combine.`,
    ],
  }),
} satisfies Refusals<ReworkResult>;

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

  if (answer(parsed, "work_rework", result, reworkRefusals)) {
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
      result.reason === "integration"
        ? "Claim the assignment again and dispatch it with no --commit. It starts from the recorded tip of its integration branch."
        : "Claim the assignment again and dispatch it from the submitted commit.",
    ],
  });
  return "reported";
}
