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

  if (result.status === "question-open") {
    report({
      json: parsed.json,
      result: {
        outcome: "missing-condition",
        reason: "question_open",
        blockers: [
          {
            reason: "question_open",
            assignmentId: result.assignmentId,
            questionId: result.questionId,
            state: result.state,
          },
        ],
        operation: "work_accept",
      },
      lines: [
        `Assignment ${result.assignmentId} still waits on question ${result.questionId}.`,
        "Deliver the answer and let the Operative acknowledge it before you accept the result.",
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
