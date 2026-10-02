import { CrewState } from "../crew-state/main.ts";
import { runInvalidate } from "./invalidate-command.ts";
import { runDispose } from "./outside-command.ts";
import { runRework } from "./rework-command.ts";
import { type ParsedArguments, readMutation, readRevision } from "./arguments.ts";
import {
  readStructuredInput,
  reportAssignmentFailure,
  reportInvalidInput,
  reportSharedFailure,
} from "./crew-result.ts";
import { type Handled, refuse, report } from "./result.ts";

async function runRegister(parsed: ParsedArguments): Promise<Handled> {
  const mutation = readMutation(parsed);
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

  if (result.status === "fixed-inputs-changed") {
    return refuse({
      json: parsed.json,
      operation: "work_register",
      outcome: "conflict",
      reason: "fixed_inputs_changed",
      detail: {
        sourceKey: result.sourceKey,
        assignmentId: result.assignmentId,
        changed: result.changed,
      },
      lines: [
        `Item ${result.sourceKey} is registered with different fixed inputs: ${result.changed.join(", ")}.`,
        "Assignment inputs stay fixed, so a changed fixed input needs your decision.",
      ],
    });
  }

  if (result.status === "fixed-input-mismatch") {
    return refuse({
      json: parsed.json,
      operation: "work_register",
      outcome: "invalid",
      reason: "fixed_input_mismatch",
      detail: {
        sourceKey: result.sourceKey,
        name: result.name,
        path: result.path,
        statedIdentity: result.statedIdentity,
        foundIdentity: result.foundIdentity,
      },
      lines: [
        result.foundIdentity === null
          ? `Item ${result.sourceKey} names ${result.path}, which is not in this checkout.`
          : `Item ${result.sourceKey} names ${result.path}, which does not match its content identity.`,
        "Nothing was registered.",
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
        overlaps: result.overlaps,
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
      ...(result.overlaps.pairCount === 0
        ? []
        : [
            `${result.overlaps.pairCount} pair(s) of items write overlapping paths: ${result.overlaps.sourceKeys.join(", ")}.`,
            `List them with: ${result.overlaps.command}`,
          ]),
    ],
  });
  return "reported";
}

async function runClaim(parsed: ParsedArguments): Promise<Handled> {
  const mutation = readMutation(parsed);
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

  if (
    reportSharedFailure(parsed, "work_claim", result) ||
    reportAssignmentFailure(parsed, "work_claim", result)
  ) {
    return "reported";
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

type AcceptanceResult = Awaited<ReturnType<typeof CrewState.accept>>["result"];

function reportAcceptancePrerequisite(
  parsed: ParsedArguments,
  result: AcceptanceResult,
): Handled | null {
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
    const blocker = required
      ? { reason: "submission_required" as const, assignmentId: result.assignmentId }
      : {
          reason: "submission_mismatch" as const,
          assignmentId: result.assignmentId,
          recordedSubmissionId: result.recordedSubmissionId,
        };
    report({
      json: parsed.json,
      result: {
        outcome: required ? "missing-condition" : "conflict",
        reason: required ? "submission_required" : "submission_mismatch",
        blockers: [blocker],
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
  return null;
}

async function runAccept(parsed: ParsedArguments): Promise<Handled> {
  const mutation = readMutation(parsed);
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

  if (
    reportSharedFailure(parsed, "work_accept", result) ||
    reportAssignmentFailure(parsed, "work_accept", result)
  ) {
    return "reported";
  }
  const prerequisite = reportAcceptancePrerequisite(parsed, result);
  if (prerequisite !== null) return prerequisite;

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

  if (result.status === "outside-changes-undisposed") {
    report({
      json: parsed.json,
      result: {
        outcome: "missing-condition",
        reason: "outside_changes_undisposed",
        blockers: [
          {
            reason: "outside_changes_undisposed",
            submissionId: result.submissionId,
            count: result.changeIds.length,
            security: result.security,
          },
        ],
        operation: "work_accept",
      },
      // The Operator reads a summary here, and the review shows each change.
      lines: [
        `${result.changeIds.length} outside change(s) of submission ${result.submissionId} carry no disposition.`,
        ...(result.security === 0
          ? []
          : [`${result.security} of them touch a security permission, so the user decides them.`]),
        "Read them with `operator review show`, then record each one with `operator work dispose`.",
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
    const blocker = required
      ? {
          reason: "pr_head_required" as const,
          assignmentId: result.assignmentId,
          recorded: result.headCommit,
        }
      : {
          reason: "pr_head_changed" as const,
          assignmentId: result.assignmentId,
          recorded: result.recorded,
          stated: result.stated,
        };
    report({
      json: parsed.json,
      result: {
        outcome: required ? "missing-condition" : "conflict",
        reason: required ? "pr_head_required" : "pr_head_changed",
        blockers: [blocker],
        operation: "work_accept",
      },
      lines: [
        required
          ? `Name the reviewed commit you read with --pr-head. The submission recorded ${result.headCommit}.`
          : `You read commit ${result.stated}. The submission recorded ${result.recorded}.`,
        "Evidence binds to the revision it was proven against.",
      ],
    });
    return "reported";
  }

  if (result.status !== "accepted") return "invalid-arguments";
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

async function runOverlaps(parsed: ParsedArguments): Promise<Handled> {
  const sourceId = parsed.crew.sourceId;
  if (sourceId === undefined) {
    return "invalid-arguments";
  }

  const { result } = await CrewState.overlaps({ projectRoot: process.cwd(), sourceId });
  if (reportSharedFailure(parsed, "work_overlaps", result)) {
    return "reported";
  }

  if (result.status === "unknown-source") {
    return refuse({
      json: parsed.json,
      operation: "work_overlaps",
      outcome: "invalid",
      reason: "unknown_source",
      detail: { sourceId: result.sourceId },
      lines: [`No source is registered as ${result.sourceId}.`],
    });
  }

  report({
    json: parsed.json,
    result: {
      outcome: "completed",
      reason: "overlaps_reported",
      blockers: [],
      operation: "work_overlaps",
      data: { sourceId: result.sourceId, overlaps: result.overlaps },
    },
    lines: [
      result.overlaps.length === 0
        ? `No two items of ${result.sourceId} write overlapping paths.`
        : `These items of ${result.sourceId} write overlapping paths:`,
      ...result.overlaps.map(
        (one) =>
          `  ${one.sourceKeys.join(" and ")}: ${one.paths.map((pair) => pair.join(" with ")).join(", ")}`,
      ),
    ],
  });
  return "reported";
}

async function runWritePaths(parsed: ParsedArguments): Promise<Handled> {
  const { assignmentId, inputPath } = parsed.crew;
  if (assignmentId === undefined) {
    return "invalid-arguments";
  }

  let input: unknown = null;
  if (inputPath !== undefined) {
    const read = await readStructuredInput({
      parsed,
      operation: "work_write_paths",
      reason: "invalid_write_paths_input",
      path: inputPath,
    });
    if (read.status !== "read") {
      return "reported";
    }
    input = read.value;
  }

  const { result } = await CrewState.writePaths({
    projectRoot: process.cwd(),
    assignmentId,
    input,
  });
  if (reportSharedFailure(parsed, "work_write_paths", result)) {
    return "reported";
  }
  if (reportAssignmentFailure(parsed, "work_write_paths", result)) {
    return "reported";
  }
  if (result.status === "invalid-input") {
    return reportInvalidInput({
      parsed,
      operation: "work_write_paths",
      reason: "invalid_write_paths_input",
      issues: result.issues,
    });
  }
  if (result.status === "not-production") {
    return refuse({
      json: parsed.json,
      operation: "work_write_paths",
      outcome: "invalid",
      reason: "not_production_work",
      detail: { assignmentId: result.assignmentId, kind: result.kind },
      lines: [
        `Assignment ${result.assignmentId} is ${result.kind} work, and it holds no write paths.`,
      ],
    });
  }

  const { status: _status, ...data } = result;
  const grant = result.grant;
  report({
    json: parsed.json,
    result: {
      outcome: "completed",
      reason: "write_paths_reported",
      blockers: [],
      operation: "work_write_paths",
      data,
    },
    lines: [
      `Assignment ${result.assignmentId} writes only inside these paths:`,
      ...result.effective.map(
        (one) => `  ${one}${result.registered.includes(one) ? "" : " (granted)"}`,
      ),
      ...(grant === null
        ? []
        : [
            "Only the person grants more write paths. Ask them with these exact words:",
            `  action "${grant.approval.action}", targets ${grant.approval.targets.join(", ")}, scope "${grant.approval.scope}", requestRevision "${grant.approval.requestRevision}".`,
            ...(grant.overlaps.length === 0
              ? ["The grant overlaps no started assignment of this source."]
              : [
                  "The grant overlaps these started assignments of this source. Both keep running, and acceptance can refuse a patch that changed:",
                  ...grant.overlaps.map(
                    (one) =>
                      `  ${one.sourceKey} (${one.assignmentId}): ${one.pathPairCount} pair(s) of paths`,
                  ),
                  `After the grant, list each pair with: ${grant.command}`,
                ]),
          ]),
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
  if (subcommand === "dispose") {
    return runDispose(parsed);
  }
  if (subcommand === "frontier") {
    return runFrontier(parsed);
  }
  if (subcommand === "overlaps") {
    return runOverlaps(parsed);
  }
  if (subcommand === "write-paths") {
    return runWritePaths(parsed);
  }

  return "invalid-arguments";
}
