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
import { type Handled, type Reason, refuse, report } from "./result.ts";
import { isSourceRefusal, reportSourceRefusal } from "./source-result.ts";

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
  const refused = plan.refusals.length > 0;
  const command = `operator work register --request <id> --owner-token <token> --input ${inputPath} --plan-revision ${plan.planRevision}`;
  const count = (change: string) => plan.items.filter((one) => one.change === change).length;
  const counts = {
    new: count("new"),
    updated: count("updated"),
    unchanged: count("unchanged"),
    withdrawn: plan.withdrawals.length,
  };
  report({
    json: parsed.json,
    result: {
      outcome: refused ? "invalid" : "completed",
      reason: refused ? "registration_refused" : "registration_planned",
      blockers: summary,
      operation,
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
        command: refused ? null : command,
      },
    },
    lines: [
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
      ...(refused
        ? [
            `  ${plan.refusals.length} refusal(s): ${summary.map((one) => `${one.reason} x${one.count}`).join(", ")}.`,
            "Nothing can be registered until each refusal is settled.",
          ]
        : [
            ...(plan.approval === null
              ? []
              : [
                  "Ask the person to approve this plan revision first. Only their approval of this exact revision records a changed source, a changed item, or a withdrawal.",
                ]),
            `Register it with: ${command}`,
          ]),
      `Every item, blocker, and refusal: ${planPath}`,
    ],
  });
  return "reported";
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

async function runRegister(parsed: ParsedArguments): Promise<Handled> {
  const inputPath = parsed.crew.inputPath;
  if (inputPath === undefined) {
    return "invalid-arguments";
  }
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
  // A planning acceptance has prerequisites of its own: its dependencies and its record.
  return reportPlanningRefusal(parsed, result);
}

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

/** The refusals of a planning acceptance: its dependencies, its record, and its authority. */
function reportPlanningRefusal(parsed: ParsedArguments, result: AcceptanceResult): Handled | null {
  if (result.status === "invalid-input") {
    return reportInvalidInput({
      parsed,
      operation: "work_accept",
      reason: "invalid_planning_record",
      issues: result.issues,
    });
  }
  if (isSourceRefusal(result)) {
    return reportSourceRefusal(parsed, "work_accept", result);
  }
  if (result.status === "artifact-unreadable" || result.status === "artifact-identity-changed") {
    const unreadable = result.status === "artifact-unreadable";
    return refuse({
      json: parsed.json,
      operation: "work_accept",
      outcome: unreadable ? "missing-condition" : "conflict",
      reason: unreadable ? "artifact_unreadable" : "artifact_identity_changed",
      detail: unreadable
        ? { name: result.name, path: result.path }
        : { name: result.name, path: result.path, found: result.found },
      lines: [
        unreadable
          ? `Artifact ${result.name} cannot be read at ${result.path}.`
          : `Artifact ${result.name} at ${result.path} does not match the identity you stated.`,
        "A planning record holds fixed texts, so nothing was accepted.",
      ],
    });
  }

  if (result.status === "dependency-pending") {
    return refuse({
      json: parsed.json,
      operation: "work_accept",
      outcome: "missing-condition",
      reason: "dependency_pending",
      detail: { assignmentId: result.assignmentId, dependencies: result.dependencies },
      lines: [
        `Assignment ${result.assignmentId} waits on work that is not accepted:`,
        ...result.dependencies.map((one) => `  ${one.assignmentId} (${one.state})`),
        "A decision is taken only on accepted inputs.",
      ],
    });
  }

  if (result.status === "planning-record-required") {
    return refuse({
      json: parsed.json,
      operation: "work_accept",
      outcome: "missing-condition",
      reason: "planning_record_required",
      detail: { assignmentId: result.assignmentId },
      lines: [
        `Assignment ${result.assignmentId} is planning work, so its acceptance records a planning record.`,
        "Name the record with --input. Its dependents receive it.",
      ],
    });
  }

  if (result.status === "planning-record-not-expected") {
    return refuse({
      json: parsed.json,
      operation: "work_accept",
      outcome: "invalid",
      reason: "planning_record_not_expected",
      detail: { assignmentId: result.assignmentId },
      lines: [`Assignment ${result.assignmentId} is not planning work, so it records no decision.`],
    });
  }

  if (result.status === "operator-decision-not-allowed") {
    return refuse({
      json: parsed.json,
      operation: "work_accept",
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
    });
  }

  if (result.status === "escalation-required") {
    return refuse({
      json: parsed.json,
      operation: "work_accept",
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
    });
  }

  return null;
}

type AcceptRequest = Parameters<typeof CrewState.accept>[0];

/** Reads every argument of one acceptance, with the planning record that planning work names. */
async function readAcceptRequest(
  parsed: ParsedArguments,
): Promise<{ status: "read"; request: AcceptRequest } | Handled> {
  const mutation = readMutation(parsed);
  const assignmentId = parsed.crew.assignmentId;
  const revision = readRevision(parsed);
  if (mutation === null || assignmentId === undefined || revision === null) {
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
      ...mutation,
      assignmentId,
      // Planning work carries no attempt, so the attempt is optional here and checked by kind.
      attemptId: parsed.crew.attemptId ?? null,
      revision,
      submissionId: parsed.crew.submissionId ?? null,
      planningRecord: record.value,
    },
  };
}

type LandingRefusalResult = Extract<
  AcceptanceResult,
  {
    status:
      | "integration-branch-missing"
      | "integration-branch-moved"
      | "integration-branch-checked-out"
      | "integration-branch-unread"
      | "landing-conflict"
      | "landing-patch-changed"
      | "landing-gate-not-passed"
      | "landing-pending"
      | "landing-tip-changed";
  }
>;

/** The lines and the outcome of one refusal of a landing. Each one landed and recorded nothing. */
function landingRefusalOf(result: LandingRefusalResult): {
  outcome: "missing-condition" | "conflict" | "pending" | "uncertain";
  reason: Parameters<typeof refuse>[0]["reason"];
  lines: string[];
} {
  switch (result.status) {
    case "integration-branch-missing":
      return {
        outcome: "missing-condition",
        reason: "integration_branch_missing",
        lines: [
          `Source ${result.sourceId} records no integration branch, so its code result has nowhere to land.`,
        ],
      };
    case "integration-branch-moved":
      return {
        outcome: "conflict",
        reason: "integration_branch_moved",
        lines: [
          `The branch ${result.branch} holds ${result.found ?? "no commit"}, and the recorded tip is ${result.recordedTip}.`,
          ...(result.checkedOut.length === 0
            ? []
            : [`It is checked out in ${result.checkedOut.join(", ")}.`]),
          "Operator never resets or adopts a moved branch. The person puts it back at the recorded tip, then accept again.",
        ],
      };
    case "integration-branch-checked-out":
      return {
        outcome: "conflict",
        reason: "integration_branch_checked_out",
        lines: [
          `The branch ${result.branch} is checked out in ${result.worktrees.join(", ")}, so it is not moved under that worktree.`,
          "The person switches that worktree off the branch, then accept again.",
        ],
      };
    case "integration-branch-unread":
      return {
        outcome: "uncertain",
        reason: "integration_branch_unread",
        lines: [`Git cannot read the branch ${result.branch}: ${result.detail}`],
      };
    case "landing-conflict":
      return {
        outcome: "conflict",
        reason: "landing_conflict",
        lines: [
          `Commit ${result.commit} conflicts with the tip ${result.tip} of ${result.branch} in ${result.paths.join(", ")}.`,
        ],
      };
    case "landing-patch-changed":
      return {
        outcome: "conflict",
        reason: "landing_patch_changed",
        lines: [
          `Commit ${result.commit} would land on ${result.tip} of ${result.branch} as another patch, so it is not the reviewed result.`,
        ],
      };
    case "landing-gate-not-passed":
      return {
        outcome:
          result.gate === "gate_pending" || result.gate === "gate_running" ? "pending" : "conflict",
        reason: result.gate,
        lines: [
          `The planned commit ${result.commit} on tip ${result.tip} has not passed the project gate.`,
          result.gate === "gate_pending"
            ? "No gate run is recorded at its key. Run `operator gate run --assignment <id>` first."
            : result.gate === "gate_running"
              ? `Gate run ${result.runIds.join(", ")} still runs at its key. Wait for its outcome.`
              : `The key is ${result.gate === "gate_flaky" ? "flaky" : "failed"} in gate run ${result.runIds.join(", ")}. Read it with \`operator gate show --run <id>\`.`,
        ],
      };
    case "landing-pending":
      return {
        outcome: "pending",
        reason: "landing_pending",
        lines: [
          `Landing ${result.landingId} of assignment ${result.pendingAssignmentId} has no recorded outcome. Settle it first with \`operator work accept\` on that assignment.`,
        ],
      };
    default:
      return {
        outcome: "conflict",
        reason: "landing_tip_changed",
        lines: [
          `The landing was planned on ${result.planned}, and the recorded tip is now ${result.recordedTip ?? "none"}. Accept again to plan it on the new tip.`,
        ],
      };
  }
}

/** Reports a landing that stopped. Nothing landed and nothing was recorded, except an open intent. */
function reportLandingRefusal(parsed: ParsedArguments, result: AcceptanceResult): Handled | null {
  switch (result.status) {
    case "integration-branch-missing":
    case "integration-branch-moved":
    case "integration-branch-checked-out":
    case "integration-branch-unread":
    case "landing-conflict":
    case "landing-patch-changed":
    case "landing-gate-not-passed":
    case "landing-pending":
    case "landing-tip-changed": {
      const { outcome, reason, lines } = landingRefusalOf(result);
      const { status: _status, ...detail } = result;
      return refuse({
        json: parsed.json,
        operation: "work_accept",
        outcome,
        reason,
        detail,
        lines: [...lines, "Nothing was accepted."],
      });
    }
    default:
      return null;
  }
}

async function runAccept(parsed: ParsedArguments): Promise<Handled> {
  const read = await readAcceptRequest(parsed);
  if (typeof read === "string") {
    return read;
  }

  const { repeated, result } = await CrewState.accept(read.request);

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

  const landing = reportLandingRefusal(parsed, result);
  if (landing !== null) return landing;

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

/** Prints one planning record in full, for the crew. The Operator reads only its pointer. */
async function runRecord(parsed: ParsedArguments): Promise<Handled> {
  const assignmentId = parsed.crew.assignmentId;
  if (assignmentId === undefined) {
    return "invalid-arguments";
  }

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
  if (subcommand === "record") {
    return runRecord(parsed);
  }

  return "invalid-arguments";
}
