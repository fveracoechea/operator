import { CrewState } from "../crew-state/main.ts";
import type { ParsedArguments } from "./arguments.ts";
import { readStructuredInput, reportInvalidInput, reportSharedFailure } from "./crew-result.ts";
import { requireReference } from "./reference.ts";
import { type Handled, refuse, report } from "./result.ts";

// The report belongs to the crew state, so this command reads its shape from that interface.
type DispatchReport = Extract<
  Awaited<ReturnType<typeof CrewState.dispatch>>,
  { report: unknown }
>["report"];

function mutationArguments(parsed: ParsedArguments) {
  const { requestId, ownerToken, attemptId } = parsed.crew;
  return requestId === undefined || ownerToken === undefined || attemptId === undefined
    ? null
    : { requestId, ownerToken, attemptId };
}

function launchLines(report: DispatchReport): string[] {
  return [
    `Attempt ${report.attemptId} on assignment ${report.assignmentId} is ${report.stage}.`,
    `Checkout ${report.worktreePath} on ${report.branch} from ${report.baseCommit}.`,
    `Operative ${report.agentName} runs on ${report.agentHost}.`,
    ...report.operations.map(
      (one) => `  ${one.kind}: ${one.state}${one.detail === null ? "" : ` (${one.detail})`}`,
    ),
  ];
}

/**
 * Reports a recorded launch snapshot this release cannot read.
 * A recovery and a replacement both restore the recorded inputs, so neither one runs on a guess.
 */
function reportUnreadableSnapshot(
  parsed: ParsedArguments,
  operation: "attempt_dispatch" | "attempt_replace",
  result: { attemptId: string; detail: string },
): Handled {
  report({
    json: parsed.json,
    result: {
      outcome: "conflict",
      reason: "snapshot_unreadable",
      blockers: [
        { reason: "snapshot_unreadable", attemptId: result.attemptId, detail: result.detail },
      ],
      operation,
      data: { attemptId: result.attemptId },
    },
    lines: [
      `Attempt ${result.attemptId} holds a recorded snapshot this release cannot read:`,
      `  ${result.detail}`,
      "The recorded inputs stay fixed, so this step needs your decision.",
    ],
  });
  return "reported";
}

async function runDispatch(parsed: ParsedArguments): Promise<Handled> {
  const mutation = mutationArguments(parsed);
  if (mutation === null) {
    return "invalid-arguments";
  }

  const result = await CrewState.dispatch({
    projectRoot: process.cwd(),
    ...mutation,
    baseCommit: parsed.crew.baseCommit ?? null,
    branch: parsed.crew.branch ?? null,
    worktreePath: parsed.crew.worktreePath ?? null,
    overrides: parsed.overrides,
  });

  if (reportSharedFailure(parsed, "attempt_dispatch", result)) {
    return "reported";
  }

  if (result.status === "review-base-changed") {
    return refuse({
      json: parsed.json,
      operation: "attempt_dispatch",
      outcome: "conflict",
      reason: "review_base_changed",
      detail: {
        attemptId: result.attemptId,
        recorded: result.recorded,
        requested: result.requested,
      },
      lines: [
        `This review reads submitted commit ${result.recorded}, not ${result.requested}.`,
        "Review inputs stay fixed, so the reviewer starts from the commit the result lives on.",
      ],
    });
  }

  if (result.status === "commit-required") {
    report({
      json: parsed.json,
      result: {
        outcome: "invalid",
        reason: "commit_required",
        blockers: [{ reason: "commit_required", attemptId: result.attemptId }],
        operation: "attempt_dispatch",
      },
      lines: ["A dispatch starts from an explicit commit. Name it with `--commit`."],
    });
    return "reported";
  }

  if (result.status === "host-unnamed") {
    report({
      json: parsed.json,
      result: {
        outcome: "missing-condition",
        reason: "host_unnamed",
        blockers: [{ reason: "host_unnamed", attemptId: result.attemptId }],
        operation: "attempt_dispatch",
      },
      lines: [
        "No crew host is selected, so this release cannot choose one for you.",
        "Set `crew.host` in the Operator configuration, or pass `--crew-host`.",
      ],
    });
    return "reported";
  }

  if (result.status === "snapshot-unreadable") {
    return reportUnreadableSnapshot(parsed, "attempt_dispatch", result);
  }

  if (result.status === "snapshot-drift") {
    report({
      json: parsed.json,
      result: {
        outcome: "conflict",
        reason: "snapshot_drift",
        blockers: result.drift.map((one) => ({ reason: "snapshot_drift" as const, ...one })),
        operation: "attempt_dispatch",
        data: { attemptId: result.attemptId },
      },
      lines: [
        `Attempt ${result.attemptId} was launched against different inputs:`,
        ...result.drift.map(
          (one) => `  ${one.input}: recorded ${one.recorded}, now ${one.current}`,
        ),
        "A recovery restores what the attempt recorded, never the current default.",
      ],
    });
    return "reported";
  }

  if (result.status === "plan-changed") {
    return refuse({
      json: parsed.json,
      operation: "attempt_dispatch",
      outcome: "conflict",
      reason: "dispatch_plan_changed",
      detail: {
        attemptId: result.attemptId,
        recorded: result.recorded,
        computed: result.computed,
      },
      lines: [
        `Attempt ${result.attemptId} holds a different fixed brief than this request builds.`,
        "Assignment inputs stay fixed at dispatch, so this needs your decision.",
      ],
    });
  }

  if (result.status === "reconciliation-required") {
    return refuse({
      json: parsed.json,
      operation: "attempt_dispatch",
      outcome: "missing-condition",
      reason: "reconciliation_required",
      detail: {
        stage: result.stage,
        operationState: result.operationState,
      },
      lines: [
        `The ${result.stage} effect of this attempt is ${result.operationState}.`,
        "Run `operator attempt reconcile` before another launch step.",
      ],
    });
  }

  if (result.status === "stage-failed" || result.status === "stage-uncertain") {
    const uncertain = result.status === "stage-uncertain";
    report({
      json: parsed.json,
      result: {
        outcome: uncertain ? "uncertain" : "failed",
        reason: uncertain ? "dispatch_stage_uncertain" : "dispatch_stage_failed",
        blockers: [
          {
            reason: uncertain ? "dispatch_stage_uncertain" : "dispatch_stage_failed",
            stage: result.stage,
            detail: result.detail,
          },
        ],
        operation: "attempt_dispatch",
        data: result.report,
      },
      lines: [
        `The ${result.stage} step ${uncertain ? "did not answer" : "failed"}: ${result.detail}`,
        ...(uncertain ? ["Run `operator attempt reconcile` before you launch again."] : []),
        ...launchLines(result.report),
      ],
    });
    return "reported";
  }

  const acknowledged = result.status === "acknowledged";
  report({
    json: parsed.json,
    result: {
      outcome: acknowledged ? "completed" : "pending",
      reason: acknowledged ? "attempt_dispatched" : "acknowledgement_pending",
      blockers: acknowledged
        ? []
        : [{ reason: "acknowledgement_pending", attemptId: result.report.attemptId }],
      operation: "attempt_dispatch",
      data: result.report,
    },
    lines: [
      ...launchLines(result.report),
      acknowledged
        ? "The Operative acknowledged the assignment."
        : "The brief is delivered. This dispatch is pending until the Operative acknowledges it.",
    ],
  });
  return "reported";
}

async function runAcknowledge(parsed: ParsedArguments): Promise<Handled> {
  const { requestId, attemptId } = parsed.crew;
  if (requestId === undefined || attemptId === undefined) {
    return "invalid-arguments";
  }

  const read = await requireReference({
    parsed,
    operation: "attempt_acknowledge",
    expectedAttemptId: attemptId,
  });
  if (read.status !== "read") {
    return "reported";
  }

  const reference = read.reference;
  const result = await CrewState.acknowledge({
    projectRoot: reference.controllingCheckout,
    requestId,
    attemptId,
    worktreePath: reference.worktreePath,
  });

  if (reportSharedFailure(parsed, "attempt_acknowledge", result)) {
    return "reported";
  }

  if (result.status === "reference-mismatch") {
    report({
      json: parsed.json,
      result: {
        outcome: "conflict",
        reason: "attempt_reference_mismatch",
        blockers: [{ reason: "attempt_reference_mismatch", attemptId, detail: result.detail }],
        operation: "attempt_acknowledge",
      },
      lines: [result.detail],
    });
    return "reported";
  }

  if (result.status === "already-acknowledged") {
    report({
      json: parsed.json,
      result: {
        outcome: "completed",
        reason: "attempt_already_acknowledged",
        blockers: [],
        operation: "attempt_acknowledge",
        data: { attemptId, acknowledgedAt: result.acknowledgedAt },
      },
      lines: [`This attempt was already acknowledged at ${result.acknowledgedAt}.`],
    });
    return "reported";
  }

  report({
    json: parsed.json,
    result: {
      outcome: "completed",
      reason: "attempt_acknowledged",
      blockers: [],
      operation: "attempt_acknowledge",
      data: {
        attemptId: result.attemptId,
        assignmentId: result.assignmentId,
        worktreePath: result.worktreePath,
      },
    },
    lines: [`Acknowledged attempt ${result.attemptId} on assignment ${result.assignmentId}.`],
  });
  return "reported";
}

async function runReconcile(parsed: ParsedArguments): Promise<Handled> {
  const mutation = mutationArguments(parsed);
  if (mutation === null) {
    return "invalid-arguments";
  }

  const result = await CrewState.reconcile({ projectRoot: process.cwd(), ...mutation });
  if (reportSharedFailure(parsed, "attempt_reconcile", result)) {
    return "reported";
  }

  const uncertain = result.status === "uncertain";
  report({
    json: parsed.json,
    result: {
      outcome: uncertain ? "uncertain" : "completed",
      reason: uncertain ? "dispatch_stage_uncertain" : "attempt_reconciled",
      blockers: result.findings
        .filter((one) => one.state === "uncertain")
        .map((one) => ({ reason: "dispatch_stage_uncertain" as const, ...one })),
      operation: "attempt_reconcile",
      data: { ...result.report, findings: result.findings },
    },
    lines: [
      ...(result.findings.length === 0
        ? ["Every recorded effect of this attempt was already settled."]
        : result.findings.map((one) => `  ${one.kind}: ${one.state} (${one.detail})`)),
      ...launchLines(result.report),
      ...(uncertain
        ? ["Unproven effects stay open. Decide them with the user before a retry."]
        : []),
    ],
  });
  return "reported";
}

async function runReplace(parsed: ParsedArguments): Promise<Handled> {
  const mutation = mutationArguments(parsed);
  if (mutation === null) {
    return "invalid-arguments";
  }

  const result = await CrewState.replace({
    projectRoot: process.cwd(),
    ...mutation,
    approvedInspection: parsed.crew.inspectionIdentity ?? null,
  });

  if (reportSharedFailure(parsed, "attempt_replace", result)) {
    return "reported";
  }

  if (result.status === "reconciliation-required") {
    report({
      json: parsed.json,
      result: {
        outcome: "missing-condition",
        reason: "reconciliation_required",
        blockers: result.pending.map((kind) => ({
          reason: "reconciliation_required" as const,
          kind,
        })),
        operation: "attempt_replace",
      },
      lines: [
        "This attempt holds unsettled effects, so a replacement could create a second writer.",
        "Run `operator attempt reconcile` first.",
      ],
    });
    return "reported";
  }

  if (result.status === "writer-live") {
    return refuse({
      json: parsed.json,
      operation: "attempt_replace",
      outcome: "conflict",
      reason: "writer_live",
      detail: {
        attemptId: result.attemptId,
        agentName: result.agentName,
        paneId: result.paneId,
      },
      lines: [
        `Operative ${result.agentName} is still live in pane ${result.paneId}.`,
        "Stop it and confirm its termination before a replacement writes.",
      ],
    });
  }

  if (result.status === "writer-unknown") {
    report({
      json: parsed.json,
      result: {
        outcome: "uncertain",
        reason: "writer_unknown",
        blockers: [
          { reason: "writer_unknown", attemptId: result.attemptId, detail: result.detail },
        ],
        operation: "attempt_replace",
      },
      lines: [`Whether the former writer stopped cannot be read: ${result.detail}`],
    });
    return "reported";
  }

  if (result.status === "inspection-required" || result.status === "inspection-stale") {
    const stale = result.status === "inspection-stale";
    report({
      json: parsed.json,
      result: {
        outcome: stale ? "conflict" : "missing-condition",
        reason: stale ? "inspection_stale" : "inspection_required",
        blockers: [
          {
            reason: stale ? "inspection_stale" : "inspection_required",
            attemptId: result.attemptId,
            identity: result.inspection.identity,
          },
        ],
        operation: "attempt_replace",
        data: result.inspection,
      },
      lines: [
        stale
          ? "The checkout changed since the inspection you approved."
          : "A replacement inspects the partial work first.",
        `Uncommitted files: ${result.inspection.uncommitted.length}. Commits since the base: ${result.inspection.commits.length}.`,
        ...result.inspection.uncommitted.map((one) => `  ${one}`),
        `Approve this exact reading with --inspection ${result.inspection.identity}`,
      ],
    });
    return "reported";
  }

  if (result.status === "snapshot-unreadable") {
    return reportUnreadableSnapshot(parsed, "attempt_replace", result);
  }

  if (result.status === "review-attempt-limit") {
    return refuse({
      json: parsed.json,
      operation: "attempt_replace",
      outcome: "missing-condition",
      reason: "review_attempt_limit",
      detail: {
        reviewId: result.reviewId,
        limit: result.limit,
      },
      lines: [
        `Review ${result.reviewId} already used its ${result.limit} attempts.`,
        "Another launch is not a remedy. Bring the blocker to the user.",
      ],
    });
  }

  report({
    json: parsed.json,
    result: {
      outcome: "completed",
      reason: "attempt_replaced",
      blockers: [],
      operation: "attempt_replace",
      data: {
        previousAttemptId: result.previousAttemptId,
        attemptId: result.attemptId,
        assignmentId: result.assignmentId,
        inspection: result.inspection,
      },
    },
    lines: [
      `Attempt ${result.previousAttemptId} is replaced by ${result.attemptId}.`,
      "The inspected checkout and branch are retained. Dispatch the new attempt to launch it.",
    ],
  });
  return "reported";
}

async function runShow(parsed: ParsedArguments): Promise<Handled> {
  const attemptId = parsed.crew.attemptId;
  if (attemptId === undefined) {
    return "invalid-arguments";
  }

  const result = await CrewState.attempt({ projectRoot: process.cwd(), attemptId });
  if (reportSharedFailure(parsed, "attempt_show", result)) {
    return "reported";
  }

  report({
    json: parsed.json,
    result: {
      outcome: "completed",
      reason: "attempt_reported",
      blockers: [],
      operation: "attempt_show",
      data: { ...result.report, acknowledgedAt: result.acknowledgedAt, current: result.current },
    },
    lines: launchLines(result.report),
  });
  return "reported";
}

async function runSubmit(parsed: ParsedArguments): Promise<Handled> {
  const { requestId, attemptId, inputPath } = parsed.crew;
  if (requestId === undefined || attemptId === undefined || inputPath === undefined) {
    return "invalid-arguments";
  }

  const located = await requireReference({
    parsed,
    operation: "attempt_submit",
    expectedAttemptId: attemptId,
  });
  if (located.status !== "read") {
    return "reported";
  }

  const reference = located.reference;
  const read = await readStructuredInput({
    parsed,
    operation: "attempt_submit",
    reason: "invalid_submission_input",
    path: inputPath,
  });
  if (read.status !== "read") {
    return "reported";
  }

  const { repeated, result } = await CrewState.submit({
    projectRoot: reference.controllingCheckout,
    requestId,
    attemptId,
    worktreePath: reference.worktreePath,
    input: read.value,
  });

  if (reportSharedFailure(parsed, "attempt_submit", result)) {
    return "reported";
  }

  if (result.status === "invalid-input") {
    return reportInvalidInput({
      parsed,
      operation: "attempt_submit",
      reason: "invalid_submission_input",
      issues: result.issues,
    });
  }

  if (result.status === "reference-mismatch") {
    report({
      json: parsed.json,
      result: {
        outcome: "conflict",
        reason: "attempt_reference_mismatch",
        blockers: [{ reason: "attempt_reference_mismatch", attemptId, detail: result.detail }],
        operation: "attempt_submit",
      },
      lines: [result.detail],
    });
    return "reported";
  }

  if (result.status === "artifact-unreadable" || result.status === "artifact-identity-changed") {
    const unreadable = result.status === "artifact-unreadable";
    report({
      json: parsed.json,
      result: {
        outcome: unreadable ? "missing-condition" : "conflict",
        reason: unreadable ? "artifact_unreadable" : "artifact_identity_changed",
        blockers: [
          {
            reason: unreadable
              ? ("artifact_unreadable" as const)
              : ("artifact_identity_changed" as const),
            name: result.name,
            path: result.path,
            ...(unreadable ? {} : { found: result.found }),
          },
        ],
        operation: "attempt_submit",
      },
      lines: [
        unreadable
          ? `Artifact ${result.name} is not at ${result.path} in this worktree.`
          : `Artifact ${result.name} at ${result.path} does not match the identity you stated.`,
        "A review reads fixed evidence, so nothing was submitted.",
      ],
    });
    return "reported";
  }

  if (result.status === "review-result-not-submitted") {
    report({
      json: parsed.json,
      result: {
        outcome: "invalid",
        reason: "review_result_not_submitted",
        blockers: [{ reason: "review_result_not_submitted", assignmentId: result.assignmentId }],
        operation: "attempt_submit",
      },
      lines: [
        "A review reports through `operator review report`, never through a submission.",
        "A review report ends the review chain and starts no second review.",
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
        operation: "attempt_submit",
      },
      lines: [`Assignment ${result.assignmentId} is planning work, so it submits no result.`],
    });
    return "reported";
  }

  if (result.status === "not-claimed") {
    return refuse({
      json: parsed.json,
      operation: "attempt_submit",
      outcome: "conflict",
      reason: "assignment_not_claimed",
      detail: {
        assignmentId: result.assignmentId,
        state: result.state,
      },
      lines: [`Assignment ${result.assignmentId} is ${result.state}, so it hands over nothing.`],
    });
  }

  if (result.status === "stale-revision") {
    return refuse({
      json: parsed.json,
      operation: "attempt_submit",
      outcome: "conflict",
      reason: "stale_revision",
      detail: {
        assignmentId: result.assignmentId,
        recordedRevision: result.recordedRevision,
      },
      lines: [`Assignment ${result.assignmentId} is at revision ${result.recordedRevision}.`],
    });
  }

  if (result.status === "source-revision-changed" || result.status === "requirements-changed") {
    const source = result.status === "source-revision-changed";
    return refuse({
      json: parsed.json,
      operation: "attempt_submit",
      outcome: "conflict",
      reason: source ? "source_revision_changed" : "requirements_changed",
      detail: {
        assignmentId: result.assignmentId,
        recorded: source ? result.recordedRevision : result.recordedIdentity,
      },
      lines: [
        source
          ? `This assignment is registered at requirement revision ${result.recordedRevision}.`
          : "The acceptance requirements you state are not the ones this assignment holds.",
        "A submission fixes the revisions it was produced against, so this needs your decision.",
      ],
    });
  }

  if (result.status === "already-submitted") {
    report({
      json: parsed.json,
      result: {
        outcome: "completed",
        reason: "result_already_submitted",
        blockers: [],
        operation: "attempt_submit",
        data: { attemptId: result.attemptId, submissionId: result.submissionId, repeated },
      },
      lines: [`This attempt already submitted result ${result.submissionId}.`],
    });
    return "reported";
  }

  report({
    json: parsed.json,
    result: {
      outcome: "pending",
      reason: "result_submitted",
      blockers: [{ reason: "review_pending", reviewId: result.reviewId }],
      operation: "attempt_submit",
      data: {
        submissionId: result.submissionId,
        identity: result.identity,
        assignmentId: result.assignmentId,
        attemptId: result.attemptId,
        revision: result.revision,
        reviewId: result.reviewId,
        reviewAssignmentId: result.reviewAssignmentId,
        reviewSourceKey: result.reviewSourceKey,
        repeated,
      },
    },
    lines: [
      `Submitted result ${result.submissionId} for assignment ${result.assignmentId}.`,
      `Review ${result.reviewId} waits on assignment ${result.reviewAssignmentId}.`,
      "A submission is a handoff to a separate review, never accepted completion.",
    ],
  });
  return "reported";
}

export async function runAttempt(words: string[], parsed: ParsedArguments): Promise<Handled> {
  if (words.length !== 1) {
    return "invalid-arguments";
  }

  const [subcommand] = words;
  if (subcommand === "dispatch") {
    return runDispatch(parsed);
  }
  if (subcommand === "acknowledge") {
    return runAcknowledge(parsed);
  }
  if (subcommand === "reconcile") {
    return runReconcile(parsed);
  }
  if (subcommand === "replace") {
    return runReplace(parsed);
  }
  if (subcommand === "show") {
    return runShow(parsed);
  }
  if (subcommand === "submit") {
    return runSubmit(parsed);
  }

  return "invalid-arguments";
}
