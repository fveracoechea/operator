import { CrewState } from "../crew-state/main.ts";
import type { ParsedArguments } from "./arguments.ts";
import { readStructuredInput, reportSharedFailure } from "./crew-result.ts";
import { report } from "./result.ts";

type Mutation = { requestId: string; ownerToken: string };

function mutationArguments(parsed: ParsedArguments): Mutation | null {
  const { requestId, ownerToken } = parsed.crew;
  return requestId === undefined || ownerToken === undefined ? null : { requestId, ownerToken };
}

function readRevision(parsed: ParsedArguments): number | null {
  const raw = parsed.crew.revision;
  if (raw === undefined || !/^\d+$/.test(raw)) {
    return null;
  }

  return Number(raw);
}

async function runRegister(parsed: ParsedArguments): Promise<"reported" | "invalid-arguments"> {
  const mutation = mutationArguments(parsed);
  const inputPath = parsed.crew.inputPath;
  if (mutation === null || inputPath === undefined) {
    return "invalid-arguments";
  }

  const read = await readStructuredInput(inputPath);
  if (!read.ok) {
    report({
      json: parsed.json,
      result: {
        outcome: "invalid",
        reason: "invalid_work_input",
        blockers: [{ reason: "invalid_work_input", detail: read.detail }],
        operation: "work_register",
      },
      lines: [`The work registration request cannot be read: ${read.detail}`],
    });
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
    report({
      json: parsed.json,
      result: {
        outcome: "invalid",
        reason: "invalid_work_input",
        blockers: result.issues.map((issue) => ({ reason: "invalid_work_input" as const, issue })),
        operation: "work_register",
      },
      lines: [
        "The work registration request is not valid:",
        ...result.issues.map((one) => `  ${one}`),
      ],
    });
    return "reported";
  }

  if (result.status === "source-revision-changed") {
    report({
      json: parsed.json,
      result: {
        outcome: "conflict",
        reason: "source_revision_changed",
        blockers: [
          {
            reason: "source_revision_changed",
            sourceId: result.sourceId,
            recordedRevision: result.recordedRevision,
            requestedRevision: result.requestedRevision,
            fixedAssignments: result.fixedAssignments,
          },
        ],
        operation: "work_register",
      },
      lines: [
        `${result.sourceId} is registered at revision ${result.recordedRevision}.`,
        "Assignment inputs stay fixed, so a changed source needs your decision.",
      ],
    });
    return "reported";
  }

  if (result.status === "unknown-dependency") {
    report({
      json: parsed.json,
      result: {
        outcome: "invalid",
        reason: "unknown_dependency",
        blockers: [
          {
            reason: "unknown_dependency",
            sourceKey: result.sourceKey,
            dependency: result.dependency,
          },
        ],
        operation: "work_register",
      },
      lines: [
        `Item ${result.sourceKey} depends on ${result.dependency.key}, which is not registered.`,
      ],
    });
    return "reported";
  }

  if (result.status === "dependencies-changed") {
    report({
      json: parsed.json,
      result: {
        outcome: "conflict",
        reason: "dependencies_changed",
        blockers: [
          {
            reason: "dependencies_changed",
            sourceKey: result.sourceKey,
            assignmentId: result.assignmentId,
            recorded: result.recorded,
            requested: result.requested,
          },
        ],
        operation: "work_register",
      },
      lines: [
        `Item ${result.sourceKey} is registered with different dependencies.`,
        "Assignment dependencies stay fixed, so a changed dependency needs your decision.",
      ],
    });
    return "reported";
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

async function runClaim(parsed: ParsedArguments): Promise<"reported" | "invalid-arguments"> {
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
    report({
      json: parsed.json,
      result: {
        outcome: "conflict",
        reason: "stale_revision",
        blockers: [
          {
            reason: "stale_revision",
            assignmentId: result.assignmentId,
            recordedRevision: result.recordedRevision,
          },
        ],
        operation: "work_claim",
      },
      lines: [
        `Assignment ${result.assignmentId} is at revision ${result.recordedRevision}.`,
        "Read the frontier again, then claim the revision you inspected.",
      ],
    });
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
    report({
      json: parsed.json,
      result: {
        outcome: "conflict",
        reason: "assignment_already_claimed",
        blockers: [
          {
            reason: "assignment_already_claimed",
            assignmentId: result.assignmentId,
            attemptId: result.attemptId,
          },
        ],
        operation: "work_claim",
      },
      lines: [
        `Assignment ${result.assignmentId} is already claimed by attempt ${result.attemptId}.`,
      ],
    });
    return "reported";
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

async function runAccept(parsed: ParsedArguments): Promise<"reported" | "invalid-arguments"> {
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
    report({
      json: parsed.json,
      result: {
        outcome: "conflict",
        reason: "stale_revision",
        blockers: [
          {
            reason: "stale_revision",
            assignmentId: result.assignmentId,
            recordedRevision: result.recordedRevision,
          },
        ],
        operation: "work_accept",
      },
      lines: [`Assignment ${result.assignmentId} is at revision ${result.recordedRevision}.`],
    });
    return "reported";
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
    report({
      json: parsed.json,
      result: {
        outcome: "invalid",
        reason: required ? "attempt_required" : "attempt_not_expected",
        blockers: [
          {
            reason: required ? "attempt_required" : "attempt_not_expected",
            assignmentId: result.assignmentId,
          },
        ],
        operation: "work_accept",
      },
      lines: [
        required
          ? `Assignment ${result.assignmentId} is executable, so acceptance names the attempt that holds it.`
          : `Assignment ${result.assignmentId} is planning work, so acceptance names no attempt.`,
      ],
    });
    return "reported";
  }

  if (result.status === "attempt-mismatch") {
    report({
      json: parsed.json,
      result: {
        outcome: "conflict",
        reason: "attempt_mismatch",
        blockers: [
          {
            reason: "attempt_mismatch",
            assignmentId: result.assignmentId,
            attemptId: result.attemptId,
          },
        ],
        operation: "work_accept",
      },
      lines: [
        result.attemptId === null
          ? `Assignment ${result.assignmentId} has no active attempt.`
          : `Assignment ${result.assignmentId} is held by attempt ${result.attemptId}.`,
      ],
    });
    return "reported";
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
    report({
      json: parsed.json,
      result: {
        outcome: "missing-condition",
        reason: "review_incomplete",
        blockers: [
          {
            reason: "review_incomplete",
            assignmentId: result.assignmentId,
            reviewId: result.reviewId,
            state: result.state,
            blocker: result.blocker,
          },
        ],
        operation: "work_accept",
      },
      lines: [
        `The review of ${result.assignmentId} is ${result.state}, so nothing is accepted.`,
        "A stopped process, a missing input, or an unavailable review capability is not a pass.",
      ],
    });
    return "reported";
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
    report({
      json: parsed.json,
      result: {
        outcome: "missing-condition",
        reason: "pr_authority_missing",
        blockers: [
          {
            reason: "pr_authority_missing",
            assignmentId: result.assignmentId,
            detail: result.detail,
          },
        ],
        operation: "work_accept",
      },
      lines: [
        "This implementation carries no pull request, so it cannot be accepted.",
        result.detail,
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

async function runFrontier(parsed: ParsedArguments): Promise<"reported" | "invalid-arguments"> {
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
      ...(result.planning.length === 0
        ? []
        : [`${result.planning.length} planning item(s) are registered and never dispatched.`]),
    ],
  });
  return "reported";
}

export async function runWork(
  words: string[],
  parsed: ParsedArguments,
): Promise<"reported" | "invalid-arguments"> {
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
  if (subcommand === "frontier") {
    return runFrontier(parsed);
  }

  return "invalid-arguments";
}
