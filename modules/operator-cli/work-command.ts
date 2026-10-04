import { CrewState } from "../crew-state/main.ts";
import { type ParsedArguments, readMutation, readRevision } from "./arguments.ts";
import {
  assignmentRefusals,
  findingsUndisposed,
  invalidInputRefusals,
  landingRefusals,
  readStructuredInput,
  reportInvalidInput,
  reportSharedFailure,
} from "./crew-result.ts";
import { planPreview } from "./plan-preview.ts";
import {
  answer,
  type Handled,
  type Reason,
  type Refusals,
  refuse,
  report,
  reportRefusal,
} from "./result.ts";
import { sourceRefusals } from "./source-result.ts";

/** The plan and its file, as the preview returns them. The refusal of a registration gives both. */
type PlanReport = Pick<
  Extract<Awaited<ReturnType<typeof CrewState.planRegistration>>["result"], { status: "planned" }>,
  "plan" | "planPath"
>;

/** Each refusal reason once, in the order it first appears, with how many times it appears. */
function refusalSummary(refusals: PlanReport["plan"]["refusals"]) {
  const counts = new Map<Reason, number>();
  for (const one of refusals) {
    counts.set(one.reason, (counts.get(one.reason) ?? 0) + 1);
  }
  return [...counts].map(([reason, count]) => ({ reason, count }));
}

/**
 * Reports one registration plan as a summary and the path of the full plan. The Operator reads
 * this report, so it carries counts and the path, and the crew or the person opens the file.
 */
function reportPlan(
  parsed: ParsedArguments,
  operation: "work_register" | "work_register_plan",
  report_: PlanReport,
  inputPath: string,
): Handled {
  const { plan, planPath } = report_;
  const summary = refusalSummary(plan.refusals);
  const count = (change: string) => plan.items.filter((one) => one.change === change).length;
  const counts = {
    new: count("new"),
    updated: count("updated"),
    unchanged: count("unchanged"),
    withdrawn: plan.withdrawals.length,
  };
  return reportRefusal(
    parsed,
    operation,
    planPreview({
      planned: "registration_planned",
      summary: [
        `Plan ${plan.planRevision} for ${plan.source.id}:`,
        `  ${counts.new} new, ${counts.updated} updated, ${counts.unchanged} unchanged item(s), ${plan.satisfiedBlockers.length} satisfied blocker(s), ${plan.skipped.length} closed sub-issue(s) not registered.`,
        ...(plan.source.change === "changed"
          ? ["  The parent issue changed, so this plan records a new source revision."]
          : []),
        ...(counts.withdrawn === 0
          ? []
          : [
              `  ${counts.withdrawn} item(s) were removed from the parent, so this plan withdraws them.`,
            ]),
      ],
      refusals: {
        reason: "registration_refused",
        count: plan.refusals.length,
        list: summary.map((one) => `${one.reason} x${one.count}`).join(", "),
        blockers: summary,
        nothing: "registered",
      },
      ask:
        plan.approval === null
          ? null
          : "Ask the person to approve this plan revision first. Only their approval of this exact revision records a changed source, a changed item, or a withdrawal.",
      apply: {
        label: "Register it with",
        command: `operator work register --request <id> --owner-token <token> --input ${inputPath} --plan-revision ${plan.planRevision}`,
      },
      path: { label: "Every item, blocker, and refusal", planPath },
      data: {
        source: plan.source,
        planRevision: plan.planRevision,
        counts: {
          ...counts,
          skipped: plan.skipped.length,
          satisfiedBlockers: plan.satisfiedBlockers.length,
          refusals: plan.refusals.length,
        },
        planPath,
        approval: plan.approval,
      },
    }),
  );
}

async function runRegisterPlan(parsed: ParsedArguments, inputPath: string): Promise<Handled> {
  // A preview changes nothing, so it carries no request identity, ownership, or revision.
  const { inputPath: _input, ...otherCrewFlags } = parsed.crew;
  if (Object.keys(otherCrewFlags).length > 0) {
    return "invalid-arguments";
  }

  const read = await readStructuredInput({
    parsed,
    operation: "work_register_plan",
    reason: "invalid_work_input",
    path: inputPath,
  });
  if (read.status !== "read") {
    return "reported";
  }

  const { result } = await CrewState.planRegistration({
    projectRoot: process.cwd(),
    input: read.value,
  });
  if (reportSharedFailure(parsed, "work_register_plan", result)) {
    return "reported";
  }
  if (result.status === "invalid-input") {
    return reportInvalidInput({
      parsed,
      operation: "work_register_plan",
      reason: "invalid_work_input",
      issues: result.issues,
    });
  }
  return reportPlan(parsed, "work_register_plan", result, inputPath);
}

export async function runRegister(parsed: ParsedArguments<"--input">): Promise<Handled> {
  const inputPath = parsed.crew.inputPath;
  if (parsed.plan) {
    return runRegisterPlan(parsed, inputPath);
  }

  // A registration records only a plan that was previewed, so it names that plan's revision.
  const mutation = readMutation(parsed);
  const planRevision = parsed.crew.planRevision;
  if (mutation === null || planRevision === undefined) {
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

  const { repeated, result, planPath } = await CrewState.register({
    projectRoot: process.cwd(),
    ...mutation,
    input: read.value,
    planRevision,
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

  if (result.status === "plan-revision-changed") {
    return refuse({
      json: parsed.json,
      operation: "work_register",
      outcome: "conflict",
      reason: "plan_revision_changed",
      detail: {
        requested: result.requested,
        found: result.found,
        differences: result.differences,
      },
      lines: [
        `The tracker or the input changed since plan ${result.requested}, so nothing was registered.`,
        ...(result.differences === null
          ? ["This checkout holds no preview of that plan, so the change cannot be named."]
          : result.differences.map((one) => `  ${one.part} ${one.key} ${one.change}`)),
        "Preview it again with --plan, and register the new plan revision.",
      ],
    });
  }

  if (result.status === "approval-required") {
    report({
      json: parsed.json,
      result: {
        outcome: "missing-condition",
        reason: "approval_required",
        blockers: [{ reason: "approval_required", approval: result.approval }],
        operation: "work_register",
      },
      lines: [
        `Plan ${result.approval.requestRevision} records a changed source, a changed item, or a withdrawal, so nothing was registered.`,
        "Ask the person to approve this exact plan revision, then register it again.",
      ],
    });
    return "reported";
  }

  if (result.status === "refused") {
    return reportPlan(
      parsed,
      "work_register",
      { plan: result.plan, planPath: planPath ?? "" },
      inputPath,
    );
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
        planRevision: result.planRevision,
        counts: {
          registered: result.registered.length,
          updated: result.updated.length,
          withdrawn: result.withdrawn.length,
        },
        overlaps: result.overlaps,
        branchReview: result.branchReview,
        repeated,
        frontier: "operator work frontier",
      },
    },
    lines: [
      `Registered ${result.registered.length} new, ${result.updated.length} updated, and ${result.withdrawn.length} withdrawn assignment(s) from ${result.source.id}.`,
      "List each assignment with: operator work frontier",
      ...(result.overlaps.pairCount === 0
        ? []
        : [
            `${result.overlaps.pairCount} pair(s) of items write overlapping paths: ${result.overlaps.sourceKeys.join(", ")}.`,
            `List them with: ${result.overlaps.command}`,
          ]),
      ...branchReviewLines(result.branchReview),
    ],
  });
  return "reported";
}

/** A mutation of one assignment at the revision the caller read. */
type AssignmentMutation = ParsedArguments<
  "--request" | "--owner-token" | "--assignment" | "--revision"
>;

export async function runClaim(parsed: AssignmentMutation): Promise<Handled> {
  const { requestId, ownerToken, assignmentId } = parsed.crew;
  const revision = readRevision(parsed);
  if (revision === null) {
    return "invalid-arguments";
  }

  const { repeated, result } = await CrewState.claim({
    projectRoot: process.cwd(),
    requestId,
    ownerToken,
    assignmentId,
    revision,
  });

  if (answer(parsed, "work_claim", result, assignmentRefusals)) {
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

  if (result.status === "withdrawn") {
    report({
      json: parsed.json,
      result: {
        outcome: "conflict",
        reason: "assignment_withdrawn",
        blockers: [{ reason: "assignment_withdrawn", assignmentId: result.assignmentId }],
        operation: "work_claim",
      },
      lines: [`Assignment ${result.assignmentId} was withdrawn, so it never starts again.`],
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

/**
 * Every acceptance that accepts nothing: a missing prerequisite, a planning record that cannot be
 * used, an unfinished review, and a landing that stopped. Nothing was recorded, except the open
 * intent of a stopped landing.
 */
const acceptRefusals = {
  ...assignmentRefusals,
  "not-claimed": (result) => ({
    outcome: "conflict",
    reason: "assignment_not_claimed",
    detail: { assignmentId: result.assignmentId, state: result.state },
    lines: [`Assignment ${result.assignmentId} is ${result.state}, so nothing can be accepted.`],
  }),
  "attempt-required": (result) => ({
    outcome: "invalid",
    reason: "attempt_required",
    detail: { assignmentId: result.assignmentId },
    lines: [
      `Assignment ${result.assignmentId} is executable, so acceptance names the attempt that holds it.`,
    ],
  }),
  "attempt-not-expected": (result) => ({
    outcome: "invalid",
    reason: "attempt_not_expected",
    detail: { assignmentId: result.assignmentId },
    lines: [`Assignment ${result.assignmentId} is planning work, so acceptance names no attempt.`],
  }),
  "attempt-mismatch": (result) => ({
    outcome: "conflict",
    reason: "attempt_mismatch",
    detail: { assignmentId: result.assignmentId, attemptId: result.attemptId },
    lines: [
      result.attemptId === null
        ? `Assignment ${result.assignmentId} has no active attempt.`
        : `Assignment ${result.assignmentId} is held by attempt ${result.attemptId}.`,
    ],
  }),
  "question-open": (result) => ({
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
  }),
  "submission-required": (result) => ({
    outcome: "missing-condition",
    reason: "submission_required",
    detail: { assignmentId: result.assignmentId },
    lines: [
      `Assignment ${result.assignmentId} has no submitted result to accept.`,
      "Acceptance names the exact submission it read.",
    ],
  }),
  "submission-mismatch": (result) => ({
    outcome: "conflict",
    reason: "submission_mismatch",
    detail: {
      assignmentId: result.assignmentId,
      recordedSubmissionId: result.recordedSubmissionId,
    },
    lines: [
      `Assignment ${result.assignmentId} holds submission ${result.recordedSubmissionId}.`,
      "Acceptance names the exact submission it read.",
    ],
  }),
  // A planning acceptance has prerequisites of its own: its dependencies and its record.
  ...invalidInputRefusals("invalid_planning_record"),
  ...sourceRefusals,
  "artifact-unreadable": (result) => ({
    outcome: "missing-condition",
    reason: "artifact_unreadable",
    detail: { name: result.name, path: result.path },
    lines: [
      `Artifact ${result.name} cannot be read at ${result.path}.`,
      "A planning record holds fixed texts, so nothing was accepted.",
    ],
  }),
  "artifact-identity-changed": (result) => ({
    outcome: "conflict",
    reason: "artifact_identity_changed",
    detail: { name: result.name, path: result.path, found: result.found },
    lines: [
      `Artifact ${result.name} at ${result.path} does not match the identity you stated.`,
      "A planning record holds fixed texts, so nothing was accepted.",
    ],
  }),
  "dependency-pending": (result) => ({
    outcome: "missing-condition",
    reason: "dependency_pending",
    detail: { assignmentId: result.assignmentId, dependencies: result.dependencies },
    lines: [
      `Assignment ${result.assignmentId} waits on work that is not accepted:`,
      ...result.dependencies.map((one) => `  ${one.assignmentId} (${one.state})`),
      "A decision is taken only on accepted inputs.",
    ],
  }),
  "planning-record-required": (result) => ({
    outcome: "missing-condition",
    reason: "planning_record_required",
    detail: { assignmentId: result.assignmentId },
    lines: [
      `Assignment ${result.assignmentId} is planning work, so its acceptance records a planning record.`,
      "Name the record with --input. Its dependents receive it.",
    ],
  }),
  "planning-record-not-expected": (result) => ({
    outcome: "invalid",
    reason: "planning_record_not_expected",
    detail: { assignmentId: result.assignmentId },
    lines: [`Assignment ${result.assignmentId} is not planning work, so it records no decision.`],
  }),
  "operator-decision-not-allowed": (result) => ({
    outcome: "missing-condition",
    reason: "operator_decision_not_allowed",
    detail: {
      assignmentId: result.assignmentId,
      entry: result.entry,
      planningType: result.planningType,
    },
    lines: [
      `Entry ${result.entry}: ${result.planningType ?? "this planning work"} is the user's side of a decision, so no entry is an Operator decision.`,
      "Record the user's answer as a human answer, or quote an approved source as a requirement.",
    ],
  }),
  "escalation-required": (result) => ({
    outcome: "missing-condition",
    reason: "escalation_required",
    detail: {
      assignmentId: result.assignmentId,
      entry: result.entry,
      authority: result.authority,
      escalationTriggers: result.escalationTriggers,
    },
    lines: [
      `Entry ${result.entry} names subjects a ${result.authority} cannot settle:`,
      ...result.escalationTriggers.map((one) => `  ${one}`),
      "Bring it to the user and record their answer as a human answer.",
    ],
  }),
  "review-incomplete": (result) => ({
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
  }),
  "review-axes-incomplete": (result) => ({
    outcome: "missing-condition",
    reason: "review_axes_incomplete",
    blockers: result.missing.map((axis) => ({
      reason: "review_axes_incomplete" as const,
      axis,
      reviewId: result.reviewId,
    })),
    lines: [`Review ${result.reviewId} is missing the ${result.missing.join(", ")} axis.`],
  }),
  "findings-undisposed": (result) => findingsUndisposed(result),
  "rework-pending": (result) => ({
    outcome: "pending",
    reason: "rework_pending",
    blockers: result.findingIds.map((findingId) => ({
      reason: "rework_pending" as const,
      findingId,
      reviewId: result.reviewId,
    })),
    lines: [`${result.findingIds.length} accepted correction(s) wait for a fresh Operative.`],
  }),
  "outside-changes-undisposed": (result) => ({
    outcome: "missing-condition",
    reason: "outside_changes_undisposed",
    detail: {
      submissionId: result.submissionId,
      count: result.changeIds.length,
      security: result.security,
    },
    // The Operator reads a summary here, and the review shows each change.
    lines: [
      `${result.changeIds.length} outside change(s) of submission ${result.submissionId} carry no disposition.`,
      ...(result.security === 0
        ? []
        : [`${result.security} of them touch a security permission, so the user decides them.`]),
      "Read them with `operator review show`, then record each one with `operator work dispose`.",
    ],
  }),
  "checks-unproven": (result) => ({
    outcome: "missing-condition",
    reason: "checks_unproven",
    blockers: result.checks.map((check) => ({ reason: "checks_unproven" as const, ...check })),
    lines: [
      "These required checks did not pass:",
      ...result.checks.map((check) => `  ${check.name}: ${check.outcome}`),
      "A passing rerun does not erase a failure, and a flaky check proves nothing.",
    ],
  }),
  "checks-contradicted": (result) => ({
    outcome: "conflict",
    reason: "checks_contradicted",
    blockers: result.checks.map((check) => ({
      reason: "checks_contradicted" as const,
      ...check,
    })),
    data: { reviewId: result.reviewId },
    lines: [
      "The review ran these checks itself and saw a different outcome:",
      ...result.checks.map(
        (check) =>
          `  ${check.name}: the producer recorded ${check.recorded}, the ${check.axis} axis saw ${check.observed}`,
      ),
      "What a reviewer ran outranks what the producer wrote about its own work.",
    ],
  }),
  "direction-required": (result) => ({
    outcome: "missing-condition",
    reason: "direction_required",
    blockers: result.directions.map((one) => ({
      reason: "direction_required" as const,
      directionRequestId: one.directionRequestId,
      limitKind: one.limitKind,
      limit: one.limitValue,
      revision: one.revision,
    })),
    data: { assignmentId: result.assignmentId, directions: result.directions },
    lines: [
      `Assignment ${result.assignmentId} reached a limit and waits on the user:`,
      ...result.directions.map(
        (one) =>
          `  ${one.directionRequestId} ${one.limitKind} at ${one.limitValue} (revision ${one.revision})`,
      ),
      "The recorded evidence is preserved. Acceptance stays blocked until the user directs it.",
    ],
  }),
  "input-invalidated": (result) => ({
    outcome: "missing-condition",
    reason: "input_invalidated",
    blockers: result.invalidated.map((assignmentId) => ({
      reason: "input_invalidated" as const,
      assignmentId,
    })),
    data: { assignmentId: result.assignmentId },
    lines: [
      `Assignment ${result.assignmentId} read a result that was found defective:`,
      ...result.invalidated.map((one) => `  ${one}`),
      "It moves again when the corrected result is accepted.",
    ],
  }),
  // A landing that stopped landed nothing and recorded nothing, except an open intent.
  ...landingRefusals({
    retry: "accept",
    gateCommand: "operator gate run --assignment <id>",
    nothing: "Nothing was accepted.",
  }),
} satisfies Refusals<AcceptanceResult>;

/** Planning work names its planning record with --input. Other work names none. */
async function readPlanningRecord(
  parsed: ParsedArguments,
): Promise<{ status: "read"; value: unknown } | { status: "reported" }> {
  const inputPath = parsed.crew.inputPath;
  return inputPath === undefined
    ? { status: "read", value: null }
    : readStructuredInput({
        parsed,
        operation: "work_accept",
        reason: "invalid_planning_record",
        path: inputPath,
      });
}

type AcceptRequest = Parameters<typeof CrewState.accept>[0];

/** Reads every argument of one acceptance, with the planning record that planning work names. */
async function readAcceptRequest(
  parsed: AssignmentMutation,
): Promise<{ status: "read"; request: AcceptRequest } | Handled> {
  const { requestId, ownerToken, assignmentId } = parsed.crew;
  const revision = readRevision(parsed);
  if (revision === null) {
    return "invalid-arguments";
  }

  const record = await readPlanningRecord(parsed);
  if (record.status !== "read") {
    return "reported";
  }

  return {
    status: "read",
    request: {
      projectRoot: process.cwd(),
      requestId,
      ownerToken,
      assignmentId,
      // Planning work carries no attempt, so the attempt is optional here and checked by kind.
      attemptId: parsed.crew.attemptId ?? null,
      revision,
      submissionId: parsed.crew.submissionId ?? null,
      planningRecord: record.value,
    },
  };
}

export async function runAccept(parsed: AssignmentMutation): Promise<Handled> {
  const read = await readAcceptRequest(parsed);
  if (typeof read === "string") {
    return read;
  }

  const { repeated, result } = await CrewState.accept(read.request);
  if (answer(parsed, "work_accept", result, acceptRefusals)) {
    return "reported";
  }

  return result.status === "accepted"
    ? reportAccepted(parsed, result, repeated)
    : "invalid-arguments";
}

function reportAccepted(
  parsed: ParsedArguments,
  result: Extract<AcceptanceResult, { status: "accepted" }>,
  repeated: boolean,
): Handled {
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
        planningRecordId: result.planningRecordId,
        landing: result.landing,
        branchReview: result.branchReview,
        repeated,
      },
    },
    lines: [
      `Accepted ${result.assignmentId}. Its dependents can now start.`,
      ...(result.landing === null
        ? []
        : [
            result.landing.from === result.landing.to
              ? `The branch ${result.landing.branch} already holds the reviewed patch in ${result.landing.landed}, so nothing landed.`
              : `Landed ${result.landing.landed} on ${result.landing.branch} (${result.landing.kind}).`,
          ]),
      ...(result.planningRecordId === null
        ? []
        : [`Recorded planning record ${result.planningRecordId}.`]),
      ...branchReviewLines(result.branchReview),
    ],
  });
  return "reported";
}

/** What one registered branch review owes, in one line or two. */
export function branchReviewLines(
  registered: Extract<AcceptanceResult, { status: "accepted" }>["branchReview"],
): string[] {
  if (registered === null) {
    return [];
  }
  return [
    `The integration branch is final, so branch review ${registered.reviewId} is registered as ${registered.assignmentId} at head ${registered.headCommit}.`,
    ...(registered.direction === null
      ? []
      : [
          `This source already holds ${registered.direction.evidence.used} branch reviews that reported, so this one waits on direction request ${registered.direction.directionRequestId}.`,
        ]),
  ];
}

export async function runFrontier(parsed: ParsedArguments): Promise<Handled> {
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

export async function runOverlaps(parsed: ParsedArguments<"--source">): Promise<Handled> {
  const sourceId = parsed.crew.sourceId;

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

export async function runWritePaths(parsed: ParsedArguments<"--assignment">): Promise<Handled> {
  const { assignmentId, inputPath } = parsed.crew;

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
  if (answer(parsed, "work_write_paths", result, assignmentRefusals)) {
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

/** Prints one planning record in full, for the crew. The Operator reads only its pointer. */
export async function runRecord(parsed: ParsedArguments<"--assignment">): Promise<Handled> {
  const assignmentId = parsed.crew.assignmentId;

  const { result } = await CrewState.planningRecord({
    projectRoot: process.cwd(),
    assignmentId,
    recordId: parsed.crew.recordId ?? null,
  });
  if (reportSharedFailure(parsed, "work_record", result)) {
    return "reported";
  }

  if (result.status === "unknown-assignment") {
    return refuse({
      json: parsed.json,
      operation: "work_record",
      outcome: "invalid",
      reason: "unknown_assignment",
      detail: { assignmentId: result.assignmentId },
      lines: [`No assignment is registered as ${result.assignmentId}.`],
    });
  }

  if (result.status === "planning-record-missing") {
    return refuse({
      json: parsed.json,
      operation: "work_record",
      outcome: "missing-condition",
      reason: "planning_record_missing",
      detail: { assignmentId: result.assignmentId, recordId: result.recordId },
      lines: [
        result.recordId === null
          ? `Assignment ${result.assignmentId} holds no planning record.`
          : `Assignment ${result.assignmentId} holds no planning record ${result.recordId}.`,
      ],
    });
  }

  const { record } = result;
  report({
    json: parsed.json,
    result: {
      outcome: "completed",
      reason: "planning_record_reported",
      blockers: [],
      operation: "work_record",
      data: { record, recordIds: result.recordIds },
    },
    lines: [
      `Planning record ${record.recordId} of ${record.assignmentId}, identity ${record.identity}.`,
      ...record.entries.map(
        (entry, index) => `  ${index + 1}. ${entry.question} (${entry.authority})`,
      ),
      ...record.artifacts.map((artifact) => `  Artifact ${artifact.name}: ${artifact.storedPath}`),
    ],
  });
  return "reported";
}
