import { CrewState } from "../crew-state/main.ts";
import { ProjectGate } from "../project-gate/main.ts";
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
    `Model ${report.agentModel ?? "host default"}, reasoning effort ${report.reasoningEffort ?? "host default"}.`,
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

type GateUnusable = Extract<
  Awaited<ReturnType<typeof CrewState.dispatch>>,
  { status: "project-gate-unusable" }
>;

/**
 * Reports a base commit whose project gate a producer cannot run, so nothing launches.
 * Setup never writes the gate and the Operator never commits, so only the person adds it.
 */
function reportGateUnusable(
  parsed: ParsedArguments,
  operation: "attempt_dispatch" | "attempt_replace",
  result: GateUnusable,
): Handled {
  const { gate } = result;
  const reason = `project_gate_${gate.status}` as const;
  return refuse({
    json: parsed.json,
    operation,
    outcome: "missing-condition",
    reason,
    detail: { attemptId: result.attemptId, commit: gate.commit, path: gate.path },
    lines: [
      ProjectGate.describe(gate, "dispatch"),
      "A producer runs the project gate before it submits, so nothing was launched.",
      `The person commits a valid ${gate.path} at the repository root. Then dispatch from a commit that holds it.`,
    ],
  });
}

type BaseGateRefusal = Extract<
  Awaited<ReturnType<typeof CrewState.dispatch>>,
  { status: "base-gate-not-passed" }
>;

/**
 * Reports a first code dispatch whose base has not passed the project gate. Nothing launches and
 * no base is fixed, and a failed or flaky base names the person, who alone clears it.
 */
function reportBaseGate(parsed: ParsedArguments, result: BaseGateRefusal): Handled {
  const blocked = result.gate === "gate_failed" || result.gate === "gate_flaky";
  return refuse({
    json: parsed.json,
    operation: "attempt_dispatch",
    outcome: blocked ? "conflict" : "missing-condition",
    reason: result.gate,
    detail: {
      attemptId: result.attemptId,
      commit: result.commit,
      tree: result.key.tree,
      declarationIdentity: result.key.declarationIdentity,
      runIds: result.runIds,
    },
    lines: [
      `The first code dispatch of this source fixes its integration base at commit ${result.commit}, and that commit has not passed the project gate.`,
      result.gate === "gate_pending"
        ? "No gate run is recorded at its key. Run `operator gate run` on this commit first."
        : result.gate === "gate_running"
          ? `Gate run ${result.runIds.join(", ")} is still running. Wait for its outcome.`
          : `The key is ${result.gate === "gate_flaky" ? "flaky" : "failed"} in gate run ${result.runIds.join(", ")}. Read it with \`operator gate show --run <id>\`.`,
      ...(blocked
        ? [
            "Only the user clears it: by a fixed main branch and a new base commit, or by an approval of a fresh series.",
          ]
        : []),
      "Nothing was launched, and no base was fixed.",
    ],
  });
}

type IntegrationRefusal = Extract<
  Awaited<ReturnType<typeof CrewState.dispatch>>,
  {
    status:
      | "integration-branch-moved"
      | "dispatch-base-not-tip"
      | "integration-branch-exists"
      | "integration-branch-held"
      | "integration-branch-unread"
      | "base-commit-unread";
  }
>;

function isIntegrationRefusal(
  result: Awaited<ReturnType<typeof CrewState.dispatch>>,
): result is IntegrationRefusal {
  return (
    result.status === "integration-branch-moved" ||
    result.status === "dispatch-base-not-tip" ||
    result.status === "integration-branch-exists" ||
    result.status === "integration-branch-held" ||
    result.status === "integration-branch-unread" ||
    result.status === "base-commit-unread"
  );
}

/**
 * Reports a production dispatch that the integration branch of its source stops (ADR 0020).
 * Operator never resets or adopts a moved branch, so each refusal names what a person checks.
 */
function reportIntegration(parsed: ParsedArguments, result: IntegrationRefusal): Handled {
  const operation = "attempt_dispatch";
  if (result.status === "integration-branch-moved") {
    return refuse({
      json: parsed.json,
      operation,
      outcome: "conflict",
      reason: "integration_branch_moved",
      detail: {
        attemptId: result.attemptId,
        branch: result.branch,
        recordedTip: result.recordedTip,
        found: result.found,
        checkedOut: result.checkedOut,
      },
      lines: [
        `Branch ${result.branch} holds ${result.found ?? "no commit"}, and its recorded tip is ${result.recordedTip}.`,
        ...result.checkedOut.map((path) => `Worktree ${path} has it checked out.`),
        "Operator never resets or adopts a moved branch. Ask the user to put it back at the recorded tip.",
        "Nothing was launched.",
      ],
    });
  }
  if (result.status === "dispatch-base-not-tip") {
    return refuse({
      json: parsed.json,
      operation,
      outcome: "conflict",
      reason: "dispatch_base_not_tip",
      detail: {
        attemptId: result.attemptId,
        branch: result.branch,
        recordedTip: result.recordedTip,
        requested: result.requested,
      },
      lines: [
        `A production dispatch of this source starts from ${result.recordedTip}, the recorded tip of ${result.branch}, not from ${result.requested}.`,
        "Run the dispatch again with no --commit.",
      ],
    });
  }
  if (result.status === "integration-branch-exists") {
    return refuse({
      json: parsed.json,
      operation,
      outcome: "conflict",
      reason: "integration_branch_exists",
      detail: {
        attemptId: result.attemptId,
        branch: result.branch,
        base: result.base,
        found: result.found,
      },
      lines: [
        `Branch ${result.branch} already holds ${result.found}, so it cannot start at the integration base ${result.base}.`,
        "Operator never takes over a branch it did not create. Ask the user to remove it, or dispatch from that commit.",
        "Nothing was launched, and no base was fixed.",
      ],
    });
  }
  if (result.status === "integration-branch-held") {
    return refuse({
      json: parsed.json,
      operation,
      outcome: "conflict",
      reason: "integration_branch_held",
      detail: { attemptId: result.attemptId, branch: result.branch, heldBy: result.heldBy },
      lines: [
        `Source ${result.heldBy} already records the integration branch ${result.branch}, so this source cannot record it.`,
        "Report it to the user. Nothing was launched, and no base was fixed.",
      ],
    });
  }
  if (result.status === "base-commit-unread") {
    return refuse({
      json: parsed.json,
      operation,
      outcome: "failed",
      reason: "gate_commit_unread",
      detail: { attemptId: result.attemptId, commit: result.commit, detail: result.detail },
      lines: [`Commit ${result.commit} could not be read: ${result.detail}`],
    });
  }
  return refuse({
    json: parsed.json,
    operation,
    outcome: "failed",
    reason: "integration_branch_unread",
    detail: { attemptId: result.attemptId, branch: result.branch, detail: result.detail },
    lines: [`Branch ${result.branch} could not be read or written: ${result.detail}`],
  });
}

/**
 * Reports the refusals of where a dispatch starts: a gate it cannot read, a base that has not
 * passed, and an integration branch that stops it, in the shape `reportSharedFailure` uses.
 */
function reportDispatchGate(
  parsed: ParsedArguments,
  result: Awaited<ReturnType<typeof CrewState.dispatch>>,
): result is GateUnusable | BaseGateRefusal | IntegrationRefusal {
  if (isIntegrationRefusal(result)) {
    reportIntegration(parsed, result);
    return true;
  }
  if (result.status === "project-gate-unusable") {
    reportGateUnusable(parsed, "attempt_dispatch", result);
    return true;
  }
  if (result.status === "base-gate-not-passed") {
    reportBaseGate(parsed, result);
    return true;
  }
  return false;
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
    paneId: process.env.HERDR_PANE_ID?.trim() || null,
    overrides: parsed.overrides,
  });

  if (reportSharedFailure(parsed, "attempt_dispatch", result)) {
    return "reported";
  }

  if (reportDispatchGate(parsed, result)) {
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
        `This review reads commit ${result.recorded}, not ${result.requested}.`,
        "Review inputs stay fixed, so the reviewer starts from the submitted commit, or from the head of the branch snapshot.",
      ],
    });
  }

  if (result.status === "correction-base-changed") {
    return refuse({
      json: parsed.json,
      operation: "attempt_dispatch",
      outcome: "conflict",
      reason: "correction_base_changed",
      detail: {
        attemptId: result.attemptId,
        recorded: result.recorded,
        requested: result.requested,
      },
      lines: [
        `This correction starts on ${result.recorded}, the parent of the landed commit, not on ${result.requested}.`,
        "The correction takes the place of the landed commit, so run the dispatch again with no --commit.",
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

  if (result.status === "workspace-required") {
    return refuse({
      json: parsed.json,
      operation: "attempt_dispatch",
      outcome: "missing-condition",
      reason: "herdr_workspace_required",
      detail: { attemptId: result.attemptId, detail: result.detail },
      lines: [
        result.detail,
        "Run dispatch from the Operator's Herdr pane to group its worktree there.",
      ],
    });
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

  if (result.status === "effort-unsupported") {
    return refuse({
      json: parsed.json,
      operation: "attempt_dispatch",
      outcome: "missing-condition",
      reason: "reasoning_effort_unsupported",
      detail: { attemptId: result.attemptId, detail: result.detail },
      lines: [result.detail],
    });
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

async function runAdopt(parsed: ParsedArguments): Promise<Handled> {
  const mutation = mutationArguments(parsed);
  if (mutation === null) {
    return "invalid-arguments";
  }

  const result = await CrewState.adopt({ projectRoot: process.cwd(), ...mutation });
  if (reportSharedFailure(parsed, "attempt_adopt", result)) {
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
        operation: "attempt_adopt",
      },
      lines: [
        "This attempt holds unsettled effects, so what it is doing is not established yet.",
        "Run `operator attempt reconcile` first.",
      ],
    });
    return "reported";
  }

  if (result.status === "writer-stopped") {
    return refuse({
      json: parsed.json,
      operation: "attempt_adopt",
      outcome: "missing-condition",
      reason: "adoption_writer_stopped",
      detail: { attemptId: result.attemptId, agentName: result.agentName },
      lines: [
        `Herdr holds no agent under ${result.agentName}, so this attempt has no writer to adopt.`,
        "Inspect its partial work and replace it with `operator attempt replace`.",
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
        operation: "attempt_adopt",
      },
      lines: [`Whether this Operative is still running cannot be read: ${result.detail}`],
    });
    return "reported";
  }

  if (result.status === "already-adopted") {
    report({
      json: parsed.json,
      result: {
        outcome: "completed",
        reason: "attempt_already_adopted",
        blockers: [],
        operation: "attempt_adopt",
        data: { attemptId: result.attemptId, assignmentId: result.assignmentId },
      },
      lines: [`This session already owns attempt ${result.attemptId}.`],
    });
    return "reported";
  }

  report({
    json: parsed.json,
    result: {
      outcome: "completed",
      reason: "attempt_adopted",
      blockers: [],
      operation: "attempt_adopt",
      data: {
        attemptId: result.attemptId,
        assignmentId: result.assignmentId,
        report: result.report,
        repeated: result.repeated,
      },
    },
    lines: [
      `Adopted attempt ${result.attemptId} on assignment ${result.assignmentId}.`,
      ...(result.report === null
        ? ["This attempt holds a claim and no launch, so dispatch it when you are ready."]
        : launchLines(result.report)),
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

  if (result.status === "project-gate-unusable") {
    return reportGateUnusable(parsed, "attempt_replace", result);
  }

  if (result.status === "review-attempt-limit") {
    const { direction } = result;
    report({
      json: parsed.json,
      result: {
        outcome: "missing-condition",
        reason: "review_attempt_limit",
        blockers: [
          {
            reason: "review_attempt_limit",
            reviewId: result.reviewId,
            limit: result.limit,
            approval: result.approval,
          },
        ],
        operation: "attempt_replace",
        data: { direction },
      },
      lines: [
        `Review ${result.reviewId} already used its ${result.limit} attempts.`,
        "Another launch is not a remedy. Bring the blocker to the user.",
        `Direction request ${direction.directionRequestId} is open at revision ${direction.revision}.`,
        `It is passed by an approval with action "${direction.approval.action}", scope "${direction.approval.scope}", and requestRevision "${direction.approval.requestRevision}".`,
      ],
    });
    return "reported";
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

type ResultRefusal = Extract<
  Awaited<ReturnType<typeof CrewState.submit>>["result"],
  { status: "result-refused" }
>["refusals"][number];

function refusalLine(refusal: ResultRefusal): string {
  switch (refusal.reason) {
    case "result_not_one_commit":
      return `  result_not_one_commit: ${refusal.commits.length} commit(s) since base ${refusal.baseCommit}, and the submission names result ${refusal.statedResult} on base ${refusal.statedBase}.`;
    case "uncommitted_work":
      return `  uncommitted_work: ${refusal.paths.join(", ")}`;
    case "outside_write_paths":
      return `  outside_write_paths: ${refusal.paths.join(", ")}. Only a person grants more write paths, so undo these changes or raise a question that names each path.`;
    case "result_check_not_run":
      return `  result_check_not_run: the ${refusal.check} check did not run. ${refusal.detail}`;
    case "behavior_change_basis_missing":
      return `  behavior_change_basis_missing: ${refusal.entries
        .map((one) => `entry ${one.position} (${one.detail})`)
        .join(", ")}`;
    case "project_gate_not_passed":
      return `  project_gate_not_passed: no passing check of ${refusal.commands.map((one) => (one.recorded.length === 0 ? `${one.name} (not recorded)` : `${one.name} (${one.recorded.join(", ")})`)).join(", ")}, from the gate at ${refusal.gateCommit}.`;
  }
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
    const blocker = unreadable
      ? { reason: "artifact_unreadable" as const, name: result.name, path: result.path }
      : {
          reason: "artifact_identity_changed" as const,
          name: result.name,
          path: result.path,
          found: result.found,
        };
    report({
      json: parsed.json,
      result: {
        outcome: unreadable ? "missing-condition" : "conflict",
        reason: unreadable ? "artifact_unreadable" : "artifact_identity_changed",
        blockers: [blocker],
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

  if (result.status === "integration-branch-unread") {
    return refuse({
      json: parsed.json,
      operation: "attempt_submit",
      outcome: "failed",
      reason: "integration_branch_unread",
      detail: { attemptId: result.attemptId, branch: result.branch, detail: result.detail },
      lines: [
        `Git cannot read the reviewed patch or the new patch of this combined revision: ${result.detail}`,
        "Nothing was submitted. This attempt still runs.",
      ],
    });
  }

  if (result.status === "result-refused") {
    report({
      json: parsed.json,
      result: {
        outcome: "conflict",
        // The refusals come in the order submit checks them, so the first one names the result.
        reason: result.refusals[0].reason,
        blockers: result.refusals,
        operation: "attempt_submit",
        data: { attemptId: result.attemptId },
      },
      lines: [
        "This result breaks its authority limits, so nothing was submitted:",
        ...result.refusals.map(refusalLine),
        "This attempt still runs. Fix each refusal, then submit again.",
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
        reworkCycleId: result.reworkCycleId,
        outsideChanges: result.outsideChanges,
        repeated,
      },
    },
    lines: [
      `Submitted result ${result.submissionId} for assignment ${result.assignmentId}.`,
      // The scan cannot name a writer, so this is a record for the Operator, never a refusal.
      ...(result.outsideChanges === 0
        ? []
        : [
            `The scan found ${result.outsideChanges} change(s) outside this worktree. The Operator disposes them before acceptance.`,
          ]),
      `Review ${result.reviewId} waits on assignment ${result.reviewAssignmentId}.`,
      ...(result.reworkCycleId === null
        ? []
        : [`This combined revision closes rework cycle ${result.reworkCycleId}.`]),
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
  if (subcommand === "adopt") {
    return runAdopt(parsed);
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
