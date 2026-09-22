import { CrewState } from "../crew-state/main.ts";
import { type ParsedArguments, readRevision } from "./arguments.ts";
import { readStructuredInput, reportInvalidInput, reportSharedFailure } from "./crew-result.ts";
import { type Handled, refuse, report } from "./result.ts";

type Mutation = { requestId: string; ownerToken: string };

function mutationArguments(parsed: ParsedArguments): Mutation | null {
  const { requestId, ownerToken } = parsed.crew;
  return requestId === undefined || ownerToken === undefined ? null : { requestId, ownerToken };
}

async function runRegister(parsed: ParsedArguments): Promise<Handled> {
  const mutation = mutationArguments(parsed);
  const inputPath = parsed.crew.inputPath;
  if (mutation === null || inputPath === undefined) {
    return "invalid-arguments";
  }

  const read = await readStructuredInput({
    parsed,
    operation: "work_register",
    reason: "invalid_work_input",
    path: inputPath,
  });
  if (read.status !== "read") {
    return "reported";
  }

  const { repeated, result } = await CrewState.register({
    projectRoot: process.cwd(),
    ...mutation,
    input: read.value,
  });

  if (reportSharedFailure(parsed, "work_register", result)) {
    return "reported";
  }

  if (result.status === "invalid-input") {
    return reportInvalidInput({
      parsed,
      operation: "work_register",
      reason: "invalid_work_input",
      issues: result.issues,
    });
  }

  if (result.status === "source-revision-changed") {
    return refuse({
      json: parsed.json,
      operation: "work_register",
      outcome: "conflict",
      reason: "source_revision_changed",
      detail: {
        sourceId: result.sourceId,
        recordedRevision: result.recordedRevision,
        requestedRevision: result.requestedRevision,
        fixedAssignments: result.fixedAssignments,
      },
      lines: [
        `${result.sourceId} is registered at revision ${result.recordedRevision}.`,
        "Assignment inputs stay fixed, so a changed source needs your decision.",
      ],
    });
  }

  if (result.status === "unknown-dependency") {
    return refuse({
      json: parsed.json,
      operation: "work_register",
      outcome: "invalid",
      reason: "unknown_dependency",
      detail: {
        sourceKey: result.sourceKey,
        dependency: result.dependency,
      },
      lines: [
        `Item ${result.sourceKey} depends on ${result.dependency.key}, which is not registered.`,
      ],
    });
  }

  if (result.status === "dependencies-changed") {
    return refuse({
      json: parsed.json,
      operation: "work_register",
      outcome: "conflict",
      reason: "dependencies_changed",
      detail: {
        sourceKey: result.sourceKey,
        assignmentId: result.assignmentId,
        recorded: result.recorded,
        requested: result.requested,
      },
      lines: [
        `Item ${result.sourceKey} is registered with different dependencies.`,
        "Assignment dependencies stay fixed, so a changed dependency needs your decision.",
      ],
    });
  }

  if (result.status === "dependency-cycle") {
    report({
      json: parsed.json,
      result: {
        outcome: "invalid",
        reason: "dependency_cycle",
        blockers: [{ reason: "dependency_cycle", cycle: result.cycle }],
        operation: "work_register",
      },
      lines: [
        "These dependencies form a cycle, so nothing was registered:",
        `  ${result.cycle.join(" -> ")}`,
      ],
    });
    return "reported";
  }

  report({
    json: parsed.json,
    result: {
      outcome: "completed",
      reason: "work_registered",
      blockers: [],
      operation: "work_register",
      data: {
        source: result.source,
        registered: result.registered,
        existing: result.existing,
        repeated,
      },
    },
    lines: [
      `Registered ${result.registered.length} assignment(s) from ${result.source.id}.`,
      ...result.registered.map(
        (one) =>
          `  ${one.assignmentId} ${one.kind}${one.executable ? "" : " (planning only)"} ${one.title}`,
      ),
      ...(result.existing.length === 0
        ? []
        : [`${result.existing.length} item(s) were already registered and stay fixed.`]),
    ],
  });
  return "reported";
}

async function runClaim(parsed: ParsedArguments): Promise<Handled> {
  const mutation = mutationArguments(parsed);
  const assignmentId = parsed.crew.assignmentId;
  const revision = readRevision(parsed);
  if (mutation === null || assignmentId === undefined || revision === null) {
    return "invalid-arguments";
  }

  const { repeated, result } = await CrewState.claim({
    projectRoot: process.cwd(),
    ...mutation,
    assignmentId,
    revision,
  });

  if (reportSharedFailure(parsed, "work_claim", result)) {
    return "reported";
  }

  if (result.status === "unknown-assignment") {
    report({
      json: parsed.json,
      result: {
        outcome: "invalid",
        reason: "unknown_assignment",
        blockers: [{ reason: "unknown_assignment", assignmentId: result.assignmentId }],
        operation: "work_claim",
      },
      lines: [`No assignment is registered as ${result.assignmentId}.`],
    });
    return "reported";
  }

  if (result.status === "stale-revision") {
    return refuse({
      json: parsed.json,
      operation: "work_claim",
      outcome: "conflict",
      reason: "stale_revision",
      detail: {
        assignmentId: result.assignmentId,
        recordedRevision: result.recordedRevision,
      },
      lines: [
        `Assignment ${result.assignmentId} is at revision ${result.recordedRevision}.`,
        "Read the frontier again, then claim the revision you inspected.",
      ],
    });
  }

  if (result.status === "planning-only") {
    report({
      json: parsed.json,
      result: {
        outcome: "invalid",
        reason: "planning_only",
        blockers: [
          { reason: "planning_only", assignmentId: result.assignmentId, kind: result.kind },
        ],
        operation: "work_claim",
      },
      lines: [`Assignment ${result.assignmentId} is planning work and is never dispatched.`],
    });
    return "reported";
  }

  if (result.status === "already-accepted") {
    report({
      json: parsed.json,
      result: {
        outcome: "conflict",
        reason: "assignment_already_accepted",
        blockers: [{ reason: "assignment_already_accepted", assignmentId: result.assignmentId }],
        operation: "work_claim",
      },
      lines: [`Assignment ${result.assignmentId} is already accepted.`],
    });
    return "reported";
  }

  if (result.status === "already-claimed") {
    return refuse({
      json: parsed.json,
      operation: "work_claim",
      outcome: "conflict",
      reason: "assignment_already_claimed",
      detail: {
        assignmentId: result.assignmentId,
        attemptId: result.attemptId,
      },
      lines: [
        `Assignment ${result.assignmentId} is already claimed by attempt ${result.attemptId}.`,
      ],
    });
  }

  if (result.status === "not-dispatchable") {
    report({
      json: parsed.json,
      result: {
        outcome: "missing-condition",
        reason: "assignment_not_dispatchable",
        blockers: result.blockers.map((blocker) => ({ ...blocker })),
        operation: "work_claim",
        data: { assignmentId: result.assignmentId },
      },
      lines: [
        `The frontier withholds assignment ${result.assignmentId}:`,
        ...result.blockers.map((blocker) => `  ${blocker.reason}`),
      ],
    });
    return "reported";
  }

  report({
    json: parsed.json,
    result: {
      outcome: "completed",
      reason: "assignment_claimed",
      blockers: [],
      operation: "work_claim",
      data: {
        assignmentId: result.assignmentId,
        attemptId: result.attemptId,
        revision: result.revision,
        kind: result.kind,
        sourceId: result.sourceId,
        sourceKey: result.sourceKey,
        repeated,
      },
    },
    lines: [
      `Claimed ${result.assignmentId} as attempt ${result.attemptId}.`,
      `Assignment revision is now ${result.revision}.`,
    ],
  });
  return "reported";
}

async function runAccept(parsed: ParsedArguments): Promise<Handled> {
  const mutation = mutationArguments(parsed);
  const assignmentId = parsed.crew.assignmentId;
  // Planning work carries no attempt, so the attempt is optional here and checked by kind.
  const attemptId = parsed.crew.attemptId ?? null;
  const revision = readRevision(parsed);
  if (mutation === null || assignmentId === undefined || revision === null) {
    return "invalid-arguments";
  }

  const { repeated, result } = await CrewState.accept({
    projectRoot: process.cwd(),
    ...mutation,
    assignmentId,
    attemptId,
    revision,
    submissionId: parsed.crew.submissionId ?? null,
    prHead: parsed.crew.prHead ?? null,
  });

  if (reportSharedFailure(parsed, "work_accept", result)) {
    return "reported";
  }

  if (result.status === "unknown-assignment") {
    report({
      json: parsed.json,
      result: {
        outcome: "invalid",
        reason: "unknown_assignment",
        blockers: [{ reason: "unknown_assignment", assignmentId: result.assignmentId }],
        operation: "work_accept",
      },
      lines: [`No assignment is registered as ${result.assignmentId}.`],
    });
    return "reported";
  }

  if (result.status === "stale-revision") {
    return refuse({
      json: parsed.json,
      operation: "work_accept",
      outcome: "conflict",
      reason: "stale_revision",
      detail: {
        assignmentId: result.assignmentId,
        recordedRevision: result.recordedRevision,
      },
      lines: [`Assignment ${result.assignmentId} is at revision ${result.recordedRevision}.`],
    });
  }

  if (result.status === "not-claimed") {
    report({
      json: parsed.json,
      result: {
        outcome: "conflict",
        reason: "assignment_not_claimed",
        blockers: [
          {
            reason: "assignment_not_claimed",
            assignmentId: result.assignmentId,
            state: result.state,
          },
        ],
        operation: "work_accept",
      },
      lines: [`Assignment ${result.assignmentId} is ${result.state}, so nothing can be accepted.`],
    });
    return "reported";
  }

  if (result.status === "attempt-required" || result.status === "attempt-not-expected") {
    const required = result.status === "attempt-required";
    return refuse({
      json: parsed.json,
      operation: "work_accept",
      outcome: "invalid",
      reason: required ? "attempt_required" : "attempt_not_expected",
      detail: { assignmentId: result.assignmentId },
      lines: [
        required
          ? `Assignment ${result.assignmentId} is executable, so acceptance names the attempt that holds it.`
          : `Assignment ${result.assignmentId} is planning work, so acceptance names no attempt.`,
      ],
    });
  }

  if (result.status === "attempt-mismatch") {
    return refuse({
      json: parsed.json,
      operation: "work_accept",
      outcome: "conflict",
      reason: "attempt_mismatch",
      detail: {
        assignmentId: result.assignmentId,
        attemptId: result.attemptId,
      },
      lines: [
        result.attemptId === null
          ? `Assignment ${result.assignmentId} has no active attempt.`
          : `Assignment ${result.assignmentId} is held by attempt ${result.attemptId}.`,
      ],
    });
  }

  if (result.status === "question-open") {
    return refuse({
      json: parsed.json,
      operation: "work_accept",
      outcome: "missing-condition",
      reason: "question_open",
      detail: {
        assignmentId: result.assignmentId,
        questionId: result.questionId,
        state: result.state,
      },
      lines: [
        `Assignment ${result.assignmentId} still waits on question ${result.questionId}.`,
        "Deliver the answer and let the Operative acknowledge it before you accept the result.",
      ],
    });
  }

  if (result.status === "submission-required" || result.status === "submission-mismatch") {
    const required = result.status === "submission-required";
    report({
      json: parsed.json,
      result: {
        outcome: required ? "missing-condition" : "conflict",
        reason: required ? "submission_required" : "submission_mismatch",
        blockers: [
          {
            reason: required ? ("submission_required" as const) : ("submission_mismatch" as const),
            assignmentId: result.assignmentId,
            ...(required ? {} : { recordedSubmissionId: result.recordedSubmissionId }),
          },
        ],
        operation: "work_accept",
      },
      lines: [
        required
          ? `Assignment ${result.assignmentId} has no submitted result to accept.`
          : `Assignment ${result.assignmentId} holds submission ${result.recordedSubmissionId}.`,
        "Acceptance names the exact submission it read.",
      ],
    });
    return "reported";
  }

  if (result.status === "review-incomplete") {
    return refuse({
      json: parsed.json,
      operation: "work_accept",
      outcome: "missing-condition",
      reason: "review_incomplete",
      detail: {
        assignmentId: result.assignmentId,
        reviewId: result.reviewId,
        state: result.state,
        blocker: result.blocker,
      },
      lines: [
        `The review of ${result.assignmentId} is ${result.state}, so nothing is accepted.`,
        "A stopped process, a missing input, or an unavailable review capability is not a pass.",
      ],
    });
  }

  if (result.status === "review-axes-incomplete") {
    report({
      json: parsed.json,
      result: {
        outcome: "missing-condition",
        reason: "review_axes_incomplete",
        blockers: result.missing.map((axis) => ({
          reason: "review_axes_incomplete" as const,
          axis,
          reviewId: result.reviewId,
        })),
        operation: "work_accept",
      },
      lines: [`Review ${result.reviewId} is missing the ${result.missing.join(", ")} axis.`],
    });
    return "reported";
  }

  if (result.status === "findings-undisposed" || result.status === "rework-pending") {
    const undisposed = result.status === "findings-undisposed";
    report({
      json: parsed.json,
      result: {
        outcome: undisposed ? "missing-condition" : "pending",
        reason: undisposed ? "findings_undisposed" : "rework_pending",
        blockers: result.findingIds.map((findingId) => ({
          reason: undisposed ? ("findings_undisposed" as const) : ("rework_pending" as const),
          findingId,
          reviewId: result.reviewId,
        })),
        operation: "work_accept",
      },
      lines: [
        undisposed
          ? `${result.findingIds.length} finding(s) of review ${result.reviewId} carry no disposition.`
          : `${result.findingIds.length} accepted correction(s) wait for a fresh Operative.`,
      ],
    });
    return "reported";
  }

  if (result.status === "checks-unproven") {
    report({
      json: parsed.json,
      result: {
        outcome: "missing-condition",
        reason: "checks_unproven",
        blockers: result.checks.map((check) => ({ reason: "checks_unproven" as const, ...check })),
        operation: "work_accept",
      },
      lines: [
        "These required checks did not pass:",
        ...result.checks.map((check) => `  ${check.name}: ${check.outcome}`),
        "A passing rerun does not erase a failure, and a flaky check proves nothing.",
      ],
    });
    return "reported";
  }

  if (result.status === "checks-contradicted") {
    report({
      json: parsed.json,
      result: {
        outcome: "conflict",
        reason: "checks_contradicted",
        blockers: result.checks.map((check) => ({
          reason: "checks_contradicted" as const,
          ...check,
        })),
        operation: "work_accept",
        data: { reviewId: result.reviewId },
      },
      lines: [
        "The review ran these checks itself and saw a different outcome:",
        ...result.checks.map(
          (check) =>
            `  ${check.name}: the producer recorded ${check.recorded}, the ${check.axis} axis saw ${check.observed}`,
        ),
        "What a reviewer ran outranks what the producer wrote about its own work.",
      ],
    });
    return "reported";
  }

  if (result.status === "pr-authority-missing") {
    return refuse({
      json: parsed.json,
      operation: "work_accept",
      outcome: "missing-condition",
      reason: "pr_authority_missing",
      detail: {
        assignmentId: result.assignmentId,
        detail: result.detail,
      },
      lines: [
        "This implementation carries no pull request, so it cannot be accepted.",
        result.detail,
      ],
    });
  }

  if (result.status === "direction-required") {
    report({
      json: parsed.json,
      result: {
        outcome: "missing-condition",
        reason: "direction_required",
        blockers: result.directions.map((one) => ({
          reason: "direction_required" as const,
          directionRequestId: one.directionRequestId,
          limitKind: one.limitKind,
          limit: one.limitValue,
          revision: one.revision,
        })),
        operation: "work_accept",
        data: { assignmentId: result.assignmentId, directions: result.directions },
      },
      lines: [
        `Assignment ${result.assignmentId} reached a limit and waits on the user:`,
        ...result.directions.map(
          (one) =>
            `  ${one.directionRequestId} ${one.limitKind} at ${one.limitValue} (revision ${one.revision})`,
        ),
        "The recorded evidence is preserved. Acceptance stays blocked until the user directs it.",
      ],
    });
    return "reported";
  }

  if (result.status === "input-invalidated") {
    report({
      json: parsed.json,
      result: {
        outcome: "missing-condition",
        reason: "input_invalidated",
        blockers: result.invalidated.map((assignmentId) => ({
          reason: "input_invalidated" as const,
          assignmentId,
        })),
        operation: "work_accept",
        data: { assignmentId: result.assignmentId },
      },
      lines: [
        `Assignment ${result.assignmentId} read a result that was found defective:`,
        ...result.invalidated.map((one) => `  ${one}`),
        "It moves again when the corrected result is accepted.",
      ],
    });
    return "reported";
  }

  if (result.status === "pr-head-required" || result.status === "pr-head-changed") {
    const required = result.status === "pr-head-required";
    report({
      json: parsed.json,
      result: {
        outcome: required ? "missing-condition" : "conflict",
        reason: required ? "pr_head_required" : "pr_head_changed",
        blockers: [
          {
            reason: required ? ("pr_head_required" as const) : ("pr_head_changed" as const),
            assignmentId: result.assignmentId,
            recorded: required ? result.headCommit : result.recorded,
            ...(required ? {} : { stated: result.stated }),
          },
        ],
        operation: "work_accept",
      },
      lines: [
        required
          ? `Name the pull request head you read with --pr-head. The submission stated ${result.headCommit}.`
          : `You read head ${result.stated}. The submission stated ${result.recorded}.`,
        "Evidence binds to the revision it was proven against.",
        "Operator does not read the pull request itself, so the head you name is the head it checks.",
      ],
    });
    return "reported";
  }

  report({
    json: parsed.json,
    result: {
      outcome: "completed",
      reason: "assignment_accepted",
      blockers: [],
      operation: "work_accept",
      data: {
        assignmentId: result.assignmentId,
        attemptId: result.attemptId,
        revision: result.revision,
        repeated,
      },
    },
    lines: [`Accepted ${result.assignmentId}. Its dependents can now start.`],
  });
  return "reported";
}

async function runRework(parsed: ParsedArguments): Promise<Handled> {
  const mutation = mutationArguments(parsed);
  const assignmentId = parsed.crew.assignmentId;
  const inputPath = parsed.crew.inputPath;
  const revision = readRevision(parsed);
  if (
    mutation === null ||
    assignmentId === undefined ||
    inputPath === undefined ||
    revision === null
  ) {
    return "invalid-arguments";
  }

  const read = await readStructuredInput({
    parsed,
    operation: "work_rework",
    reason: "invalid_rework_input",
    path: inputPath,
  });
  if (read.status !== "read") {
    return "reported";
  }

  const { repeated, result } = await CrewState.rework({
    projectRoot: process.cwd(),
    ...mutation,
    assignmentId,
    revision,
    input: read.value,
  });

  if (reportSharedFailure(parsed, "work_rework", result)) {
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

  if (result.status === "unknown-assignment") {
    return refuse({
      json: parsed.json,
      operation: "work_rework",
      outcome: "invalid",
      reason: "unknown_assignment",
      detail: { assignmentId: result.assignmentId },
      lines: [`No assignment is registered as ${result.assignmentId}.`],
    });
  }

  if (result.status === "stale-revision") {
    return refuse({
      json: parsed.json,
      operation: "work_rework",
      outcome: "conflict",
      reason: "stale_revision",
      detail: { assignmentId: result.assignmentId, recordedRevision: result.recordedRevision },
      lines: [`Assignment ${result.assignmentId} is at revision ${result.recordedRevision}.`],
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

async function runInvalidate(parsed: ParsedArguments): Promise<Handled> {
  const mutation = mutationArguments(parsed);
  const assignmentId = parsed.crew.assignmentId;
  const inputPath = parsed.crew.inputPath;
  const revision = readRevision(parsed);
  if (
    mutation === null ||
    assignmentId === undefined ||
    inputPath === undefined ||
    revision === null
  ) {
    return "invalid-arguments";
  }

  const read = await readStructuredInput({
    parsed,
    operation: "work_invalidate",
    reason: "invalid_defect_input",
    path: inputPath,
  });
  if (read.status !== "read") {
    return "reported";
  }

  const { repeated, result } = await CrewState.invalidate({
    projectRoot: process.cwd(),
    ...mutation,
    assignmentId,
    revision,
    input: read.value,
  });

  if (reportSharedFailure(parsed, "work_invalidate", result)) {
    return "reported";
  }

  if (result.status === "invalid-input") {
    return reportInvalidInput({
      parsed,
      operation: "work_invalidate",
      reason: "invalid_defect_input",
      issues: result.issues,
    });
  }

  if (result.status === "unknown-assignment") {
    return refuse({
      json: parsed.json,
      operation: "work_invalidate",
      outcome: "invalid",
      reason: "unknown_assignment",
      detail: { assignmentId: result.assignmentId },
      lines: [`No assignment is registered as ${result.assignmentId}.`],
    });
  }

  if (result.status === "stale-revision") {
    return refuse({
      json: parsed.json,
      operation: "work_invalidate",
      outcome: "conflict",
      reason: "stale_revision",
      detail: { assignmentId: result.assignmentId, recordedRevision: result.recordedRevision },
      lines: [`Assignment ${result.assignmentId} is at revision ${result.recordedRevision}.`],
    });
  }

  if (result.status === "review-not-invalidated") {
    return refuse({
      json: parsed.json,
      operation: "work_invalidate",
      outcome: "invalid",
      reason: "review_not_invalidated",
      detail: { assignmentId: result.assignmentId },
      lines: [
        `Assignment ${result.assignmentId} is review work, which holds no result of its own.`,
        "A review that read the work wrongly is answered by reviewing that work again.",
      ],
    });
  }

  if (result.status === "not-accepted") {
    return refuse({
      json: parsed.json,
      operation: "work_invalidate",
      outcome: "conflict",
      reason: "assignment_not_accepted",
      detail: { assignmentId: result.assignmentId, state: result.state },
      lines: [
        `Assignment ${result.assignmentId} is ${result.state}, so it holds no accepted result.`,
        "Unaccepted work is corrected through a rework cycle instead.",
      ],
    });
  }

  report({
    json: parsed.json,
    result: {
      outcome: "completed",
      reason: "result_invalidated",
      blockers: [],
      operation: "work_invalidate",
      data: {
        assignmentId: result.assignmentId,
        revision: result.revision,
        invalidationId: result.invalidationId,
        submissionId: result.submissionId,
        dependents: result.dependents,
        repeated,
      },
    },
    lines: [
      `Recorded defect ${result.invalidationId} against ${result.assignmentId}.`,
      "Its acceptance, submission, review, and findings stay recorded.",
      ...(result.dependents.length === 0
        ? ["No dependent consumed the result, so nothing was paused."]
        : [
            `${result.dependents.length} dependent(s) read it and are paused:`,
            ...result.dependents.map((one) => `  ${one.assignmentId} was ${one.consumedState}`),
          ]),
      "A dependent that never started is held by the dependency gate, not paused.",
    ],
  });
  return "reported";
}

async function runFrontier(parsed: ParsedArguments): Promise<Handled> {
  const { result } = await CrewState.frontier({ projectRoot: process.cwd() });
  if (reportSharedFailure(parsed, "work_frontier", result)) {
    return "reported";
  }

  const reason =
    result.dispatchable.length > 0
      ? ("frontier_ready" as const)
      : result.blocked.length > 0
        ? ("frontier_blocked" as const)
        : ("frontier_empty" as const);

  report({
    json: parsed.json,
    result: {
      outcome: reason === "frontier_blocked" ? "missing-condition" : "completed",
      reason,
      blockers: result.blocked.flatMap((one) =>
        one.blockers.map((blocker) => ({ ...blocker, assignmentId: one.assignmentId })),
      ),
      operation: "work_frontier",
      data: result,
    },
    lines: [
      `Crew limit ${result.capacity.limit} (${result.capacity.limitSource}), review reserve ${result.capacity.reviewReserve}.`,
      `Active ${result.capacity.active.total}: ${result.capacity.active.production} production, ${result.capacity.active.review} review.`,
      ...(result.dispatchable.length === 0
        ? ["Nothing is dispatchable now."]
        : [
            "Dispatchable now:",
            ...result.dispatchable.map(
              (one) => `  ${one.assignmentId} r${one.revision} ${one.kind} ${one.title}`,
            ),
          ]),
      ...(result.blocked.length === 0
        ? []
        : [
            "Waiting:",
            ...result.blocked.map(
              (one) => `  ${one.assignmentId} ${one.blockers.map((b) => b.reason).join(", ")}`,
            ),
          ]),
      ...(result.questions.length === 0
        ? []
        : [
            "Waiting on an answer:",
            ...result.questions.map(
              (one) =>
                `  ${one.questionId} ${one.state} on ${one.assignmentId}${
                  one.escalationTriggers.length === 0
                    ? ""
                    : ` (needs the user: ${one.escalationTriggers.join(", ")})`
                }`,
            ),
          ]),
      ...(result.planning.length === 0
        ? []
        : [`${result.planning.length} planning item(s) are registered and never dispatched.`]),
    ],
  });
  return "reported";
}

export async function runWork(words: string[], parsed: ParsedArguments): Promise<Handled> {
  if (words.length !== 1) {
    return "invalid-arguments";
  }

  const [subcommand] = words;
  if (subcommand === "register") {
    return runRegister(parsed);
  }
  if (subcommand === "claim") {
    return runClaim(parsed);
  }
  if (subcommand === "accept") {
    return runAccept(parsed);
  }
  if (subcommand === "rework") {
    return runRework(parsed);
  }
  if (subcommand === "invalidate") {
    return runInvalidate(parsed);
  }
  if (subcommand === "frontier") {
    return runFrontier(parsed);
  }

  return "invalid-arguments";
}
