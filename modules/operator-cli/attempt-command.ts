import { CrewState } from "../crew-state/main.ts";
import { ProjectGate } from "../project-gate/main.ts";
import type { ParsedArguments } from "./arguments.ts";
import { invalidInputRefusals, readStructuredInput, reportSharedFailure } from "./crew-result.ts";
import { requireReference } from "./reference.ts";
import { answer, type Handled, type Refusal, type Refusals, refuse, report } from "./result.ts";

// The report belongs to the crew state, so this command reads its shape from that interface.
type DispatchReport = Extract<
  Awaited<ReturnType<typeof CrewState.dispatch>>,
  { report: unknown }
>["report"];

/** A mutation of one attempt: the request, the ownership, and the attempt it names. */
type AttemptMutation = ParsedArguments<"--request" | "--owner-token" | "--attempt">;

function mutationArguments(parsed: AttemptMutation) {
  const { requestId, ownerToken, attemptId } = parsed.crew;
  return { requestId, ownerToken, attemptId };
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

type DispatchResult = Awaited<ReturnType<typeof CrewState.dispatch>>;
type ReplaceResult = Awaited<ReturnType<typeof CrewState.replace>>;

/**
 * The answers a dispatch and a replacement share: a recorded launch snapshot this release cannot
 * read, and a base commit whose project gate a producer cannot run. Both restore the recorded
 * inputs, so neither one runs on a guess. Setup never writes the gate and the Operator never
 * commits, so only the person adds it.
 */
const launchRefusals = {
  "snapshot-unreadable": (result: { attemptId: string; detail: string }): Refusal => ({
    outcome: "conflict",
    reason: "snapshot_unreadable",
    detail: { attemptId: result.attemptId, detail: result.detail },
    data: { attemptId: result.attemptId },
    lines: [
      `Attempt ${result.attemptId} holds a recorded snapshot this release cannot read:`,
      `  ${result.detail}`,
      "The recorded inputs stay fixed, so this step needs your decision.",
    ],
  }),
  "project-gate-unusable": (
    result: Extract<DispatchResult, { status: "project-gate-unusable" }>,
  ): Refusal => ({
    outcome: "missing-condition",
    reason: `project_gate_${result.gate.status}`,
    detail: { attemptId: result.attemptId, commit: result.gate.commit, path: result.gate.path },
    lines: [
      ProjectGate.describe(result.gate, "dispatch"),
      "A producer runs the project gate before it submits, so nothing was launched.",
      `The person commits a valid ${result.gate.path} at the repository root. Then dispatch from a commit that holds it.`,
    ],
  }),
};

type BaseGate = Extract<DispatchResult, { status: "base-gate-not-passed" }>;

/** What a person reads about a base whose key has not passed, for each gate state. */
const baseGateLines: { [G in BaseGate["gate"]]: (result: BaseGate) => string[] } = {
  gate_pending: () => [
    "No gate run is recorded at its key. Run `operator gate run` on this commit first.",
  ],
  gate_running: (result) => [
    `Gate run ${result.runIds.join(", ")} is still running. Wait for its outcome.`,
  ],
  gate_failed: (result) => blockedBase("failed", result),
  gate_flaky: (result) => blockedBase("flaky", result),
};

/** A failed or flaky base names the person, who alone clears it. */
function blockedBase(state: "failed" | "flaky", result: BaseGate): string[] {
  return [
    `The key is ${state} in gate run ${result.runIds.join(", ")}. Read it with \`operator gate show --run <id>\`.`,
    "Only the user clears it: by a fixed main branch and a new base commit, or by an approval of a fresh series.",
  ];
}

function stageStopped(
  result: Extract<DispatchResult, { status: "stage-failed" | "stage-uncertain" }>,
): Refusal {
  const uncertain = result.status === "stage-uncertain";
  const reason = uncertain ? "dispatch_stage_uncertain" : "dispatch_stage_failed";
  return {
    outcome: uncertain ? "uncertain" : "failed",
    reason,
    blockers: [{ reason, stage: result.stage, detail: result.detail }],
    data: result.report,
    lines: [
      `The ${result.stage} step ${uncertain ? "did not answer" : "failed"}: ${result.detail}`,
      ...(uncertain ? ["Run `operator attempt reconcile` before you launch again."] : []),
      ...launchLines(result.report),
    ],
  };
}

/**
 * The answers of a dispatch that launched nothing, or that stopped at one launch step. A
 * production dispatch can be stopped by the integration branch of its source (ADR 0020).
 * Operator never resets or adopts a moved branch, so each such refusal names what a person
 * checks. A first code dispatch whose base has not passed the project gate fixes no base.
 */
const dispatchRefusals = {
  ...launchRefusals,
  "integration-branch-moved": (result) => ({
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
  }),
  "dispatch-base-not-tip": (result) => ({
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
  }),
  "integration-branch-exists": (result) => ({
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
  }),
  "integration-branch-held": (result) => ({
    outcome: "conflict",
    reason: "integration_branch_held",
    detail: { attemptId: result.attemptId, branch: result.branch, heldBy: result.heldBy },
    lines: [
      `Source ${result.heldBy} already records the integration branch ${result.branch}, so this source cannot record it.`,
      "Report it to the user. Nothing was launched, and no base was fixed.",
    ],
  }),
  "integration-branch-unread": (result) => ({
    outcome: "failed",
    reason: "integration_branch_unread",
    detail: { attemptId: result.attemptId, branch: result.branch, detail: result.detail },
    lines: [`Branch ${result.branch} could not be read or written: ${result.detail}`],
  }),
  "base-commit-unread": (result) => ({
    outcome: "failed",
    reason: "gate_commit_unread",
    detail: { attemptId: result.attemptId, commit: result.commit, detail: result.detail },
    lines: [`Commit ${result.commit} could not be read: ${result.detail}`],
  }),
  "base-gate-not-passed": (result) => ({
    outcome:
      result.gate === "gate_failed" || result.gate === "gate_flaky"
        ? "conflict"
        : "missing-condition",
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
      ...baseGateLines[result.gate](result),
      "Nothing was launched, and no base was fixed.",
    ],
  }),
  "review-base-changed": (result) => ({
    outcome: "conflict",
    reason: "review_base_changed",
    detail: { attemptId: result.attemptId, recorded: result.recorded, requested: result.requested },
    lines: [
      `This review reads commit ${result.recorded}, not ${result.requested}.`,
      "Review inputs stay fixed, so the reviewer starts from the submitted commit, or from the head of the branch snapshot.",
    ],
  }),
  "correction-base-changed": (result) => ({
    outcome: "conflict",
    reason: "correction_base_changed",
    detail: { attemptId: result.attemptId, recorded: result.recorded, requested: result.requested },
    lines: [
      `This correction starts on ${result.recorded}, the parent of the landed commit, not on ${result.requested}.`,
      "The correction takes the place of the landed commit, so run the dispatch again with no --commit.",
    ],
  }),
  "commit-required": (result) => ({
    outcome: "invalid",
    reason: "commit_required",
    detail: { attemptId: result.attemptId },
    lines: ["A dispatch starts from an explicit commit. Name it with `--commit`."],
  }),
  "workspace-required": (result) => ({
    outcome: "missing-condition",
    reason: "herdr_workspace_required",
    detail: { attemptId: result.attemptId, detail: result.detail },
    lines: [
      result.detail,
      "Run dispatch from the Operator's Herdr pane to group its worktree there.",
    ],
  }),
  "host-unnamed": (result) => ({
    outcome: "missing-condition",
    reason: "host_unnamed",
    detail: { attemptId: result.attemptId },
    lines: [
      "No crew host is selected, so this release cannot choose one for you.",
      "Set `crew.host` in the Operator configuration, or pass `--crew-host`.",
    ],
  }),
  "effort-unsupported": (result) => ({
    outcome: "missing-condition",
    reason: "reasoning_effort_unsupported",
    detail: { attemptId: result.attemptId, detail: result.detail },
    lines: [result.detail],
  }),
  "snapshot-drift": (result) => ({
    outcome: "conflict",
    reason: "snapshot_drift",
    blockers: result.drift.map((one) => ({ reason: "snapshot_drift" as const, ...one })),
    data: { attemptId: result.attemptId },
    lines: [
      `Attempt ${result.attemptId} was launched against different inputs:`,
      ...result.drift.map((one) => `  ${one.input}: recorded ${one.recorded}, now ${one.current}`),
      "A recovery restores what the attempt recorded, never the current default.",
    ],
  }),
  "plan-changed": (result) => ({
    outcome: "conflict",
    reason: "dispatch_plan_changed",
    detail: { attemptId: result.attemptId, recorded: result.recorded, computed: result.computed },
    lines: [
      `Attempt ${result.attemptId} holds a different fixed brief than this request builds.`,
      "Assignment inputs stay fixed at dispatch, so this needs your decision.",
    ],
  }),
  "reconciliation-required": (result) => ({
    outcome: "missing-condition",
    reason: "reconciliation_required",
    detail: { stage: result.stage, operationState: result.operationState },
    lines: [
      `The ${result.stage} effect of this attempt is ${result.operationState}.`,
      "Run `operator attempt reconcile` before another launch step.",
    ],
  }),
  "stage-failed": stageStopped,
  "stage-uncertain": stageStopped,
} satisfies Refusals<DispatchResult>;

export async function runDispatch(parsed: AttemptMutation): Promise<Handled> {
  const mutation = mutationArguments(parsed);

  const result = await CrewState.dispatch({
    projectRoot: process.cwd(),
    ...mutation,
    baseCommit: parsed.crew.baseCommit ?? null,
    branch: parsed.crew.branch ?? null,
    worktreePath: parsed.crew.worktreePath ?? null,
    paneId: process.env.HERDR_PANE_ID?.trim() || null,
    overrides: parsed.overrides,
  });

  if (answer(parsed, "attempt_dispatch", result, dispatchRefusals)) {
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

export async function runAcknowledge(
  parsed: ParsedArguments<"--request" | "--attempt">,
): Promise<Handled> {
  const { requestId, attemptId } = parsed.crew;

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

export async function runReconcile(parsed: AttemptMutation): Promise<Handled> {
  const mutation = mutationArguments(parsed);

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

export async function runAdopt(parsed: AttemptMutation): Promise<Handled> {
  const mutation = mutationArguments(parsed);

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

function inspectionAnswer(
  result: Extract<ReplaceResult, { status: "inspection-required" | "inspection-stale" }>,
): Refusal {
  const stale = result.status === "inspection-stale";
  const reason = stale ? "inspection_stale" : "inspection_required";
  return {
    outcome: stale ? "conflict" : "missing-condition",
    reason,
    blockers: [{ reason, attemptId: result.attemptId, identity: result.inspection.identity }],
    data: result.inspection,
    lines: [
      stale
        ? "The checkout changed since the inspection you approved."
        : "A replacement inspects the partial work first.",
      `Uncommitted files: ${result.inspection.uncommitted.length}. Commits since the base: ${result.inspection.commits.length}.`,
      ...result.inspection.uncommitted.map((one) => `  ${one}`),
      `Approve this exact reading with --inspection ${result.inspection.identity}`,
    ],
  };
}

/**
 * The answers of a replacement that wrote nothing: a former writer that may still write, partial
 * work that waits for an approved inspection, and a review that used every attempt it has.
 */
const replaceRefusals = {
  ...launchRefusals,
  "reconciliation-required": (result) => ({
    outcome: "missing-condition",
    reason: "reconciliation_required",
    blockers: result.pending.map((kind) => ({ reason: "reconciliation_required" as const, kind })),
    lines: [
      "This attempt holds unsettled effects, so a replacement could create a second writer.",
      "Run `operator attempt reconcile` first.",
    ],
  }),
  "writer-live": (result) => ({
    outcome: "conflict",
    reason: "writer_live",
    detail: { attemptId: result.attemptId, agentName: result.agentName, paneId: result.paneId },
    lines: [
      `Operative ${result.agentName} is still live in pane ${result.paneId}.`,
      "Stop it and confirm its termination before a replacement writes.",
    ],
  }),
  "writer-unknown": (result) => ({
    outcome: "uncertain",
    reason: "writer_unknown",
    detail: { attemptId: result.attemptId, detail: result.detail },
    lines: [`Whether the former writer stopped cannot be read: ${result.detail}`],
  }),
  "inspection-required": inspectionAnswer,
  "inspection-stale": inspectionAnswer,
  "review-attempt-limit": ({ reviewId, limit, approval, direction }) => ({
    outcome: "missing-condition",
    reason: "review_attempt_limit",
    detail: { reviewId, limit, approval },
    data: { direction },
    lines: [
      `Review ${reviewId} already used its ${limit} attempts.`,
      "Another launch is not a remedy. Bring the blocker to the user.",
      `Direction request ${direction.directionRequestId} is open at revision ${direction.revision}.`,
      `It is passed by an approval with action "${direction.approval.action}", scope "${direction.approval.scope}", and requestRevision "${direction.approval.requestRevision}".`,
    ],
  }),
} satisfies Refusals<ReplaceResult>;

export async function runReplace(parsed: AttemptMutation): Promise<Handled> {
  const mutation = mutationArguments(parsed);

  const result = await CrewState.replace({
    projectRoot: process.cwd(),
    ...mutation,
    approvedInspection: parsed.crew.inspectionIdentity ?? null,
  });

  if (answer(parsed, "attempt_replace", result, replaceRefusals)) {
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

export async function runShow(parsed: ParsedArguments<"--attempt">): Promise<Handled> {
  const attemptId = parsed.crew.attemptId;

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
      return `  outside_write_paths: ${refusal.paths.join(", ")}. Only a person grants more write paths, so undo these changes or raise a question with the \`security-permissions\` trigger that names each path.`;
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

type SubmitResult = Awaited<ReturnType<typeof CrewState.submit>>["result"];

function artifactAnswer(
  result: Extract<SubmitResult, { status: "artifact-unreadable" | "artifact-identity-changed" }>,
): Refusal {
  const unreadable = result.status === "artifact-unreadable";
  return {
    outcome: unreadable ? "missing-condition" : "conflict",
    reason: unreadable ? "artifact_unreadable" : "artifact_identity_changed",
    blockers: [
      unreadable
        ? { reason: "artifact_unreadable", name: result.name, path: result.path }
        : {
            reason: "artifact_identity_changed",
            name: result.name,
            path: result.path,
            found: result.found,
          },
    ],
    lines: [
      unreadable
        ? `Artifact ${result.name} is not at ${result.path} in this worktree.`
        : `Artifact ${result.name} at ${result.path} does not match the identity you stated.`,
      "A review reads fixed evidence, so nothing was submitted.",
    ],
  };
}

function revisionAnswer(
  result: Extract<SubmitResult, { status: "source-revision-changed" | "requirements-changed" }>,
): Refusal {
  const source = result.status === "source-revision-changed";
  return {
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
  };
}

/**
 * The answers of a submission that recorded nothing: a request or an artifact it cannot read, a
 * result that breaks its authority limits, and an assignment that hands over no result here.
 */
const submitRefusals = {
  ...invalidInputRefusals("invalid_submission_input"),
  "reference-mismatch": (result) => ({
    outcome: "conflict",
    reason: "attempt_reference_mismatch",
    detail: { attemptId: result.attemptId, detail: result.detail },
    lines: [result.detail],
  }),
  "artifact-unreadable": artifactAnswer,
  "artifact-identity-changed": artifactAnswer,
  "integration-branch-unread": (result) => ({
    outcome: "failed",
    reason: "integration_branch_unread",
    detail: { attemptId: result.attemptId, branch: result.branch, detail: result.detail },
    lines: [
      `Git cannot read the reviewed patch or the new patch of this combined revision: ${result.detail}`,
      "Nothing was submitted. This attempt still runs.",
    ],
  }),
  "result-refused": (result) => ({
    outcome: "conflict",
    // The refusals come in the order submit checks them, so the first one names the result.
    reason: result.refusals[0].reason,
    blockers: result.refusals,
    data: { attemptId: result.attemptId },
    lines: [
      "This result breaks its authority limits, so nothing was submitted:",
      ...result.refusals.map(refusalLine),
      "This attempt still runs. Fix each refusal, then submit again.",
    ],
  }),
  "review-result-not-submitted": (result) => ({
    outcome: "invalid",
    reason: "review_result_not_submitted",
    detail: { assignmentId: result.assignmentId },
    lines: [
      "A review reports through `operator review report`, never through a submission.",
      "A review report ends the review chain and starts no second review.",
    ],
  }),
  "planning-only": (result) => ({
    outcome: "invalid",
    reason: "planning_only",
    detail: { assignmentId: result.assignmentId, kind: result.kind },
    lines: [`Assignment ${result.assignmentId} is planning work, so it submits no result.`],
  }),
  "not-claimed": (result) => ({
    outcome: "conflict",
    reason: "assignment_not_claimed",
    detail: { assignmentId: result.assignmentId, state: result.state },
    lines: [`Assignment ${result.assignmentId} is ${result.state}, so it hands over nothing.`],
  }),
  "stale-revision": (result) => ({
    outcome: "conflict",
    reason: "stale_revision",
    detail: { assignmentId: result.assignmentId, recordedRevision: result.recordedRevision },
    lines: [`Assignment ${result.assignmentId} is at revision ${result.recordedRevision}.`],
  }),
  "source-revision-changed": revisionAnswer,
  "requirements-changed": revisionAnswer,
} satisfies Refusals<SubmitResult>;

export async function runSubmit(
  parsed: ParsedArguments<"--request" | "--attempt" | "--input">,
): Promise<Handled> {
  const { requestId, attemptId, inputPath } = parsed.crew;

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

  if (answer(parsed, "attempt_submit", result, submitRefusals)) {
    return "reported";
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

  return reportSubmitted(parsed, result, repeated);
}

function reportSubmitted(
  parsed: ParsedArguments,
  result: Extract<SubmitResult, { status: "submitted" }>,
  repeated: boolean,
): Handled {
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
