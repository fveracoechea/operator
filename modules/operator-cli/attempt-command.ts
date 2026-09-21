import { CrewState } from "../crew-state/main.ts";
import { OperativeDispatch } from "../operative-dispatch/main.ts";
import type { ParsedArguments } from "./arguments.ts";
import { reportSharedFailure } from "./crew-result.ts";
import { report } from "./result.ts";

type Handled = "reported" | "invalid-arguments";

type DispatchReport = {
  attemptId: string;
  assignmentId: string;
  stage: string;
  branch: string;
  baseCommit: string;
  worktreePath: string;
  agentName: string;
  agentHost: string;
  operations: Array<{ kind: string; state: string; detail: string | null }>;
};

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

async function runDispatch(parsed: ParsedArguments): Promise<Handled> {
  const mutation = mutationArguments(parsed);
  if (mutation === null) {
    return "invalid-arguments";
  }

  const { result } = await CrewState.dispatch({
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
    report({
      json: parsed.json,
      result: {
        outcome: "conflict",
        reason: "dispatch_plan_changed",
        blockers: [
          {
            reason: "dispatch_plan_changed",
            attemptId: result.attemptId,
            recorded: result.recorded,
            computed: result.computed,
          },
        ],
        operation: "attempt_dispatch",
      },
      lines: [
        `Attempt ${result.attemptId} holds a different fixed brief than this request builds.`,
        "Assignment inputs stay fixed at dispatch, so this needs your decision.",
      ],
    });
    return "reported";
  }

  if (result.status === "reconciliation-required") {
    report({
      json: parsed.json,
      result: {
        outcome: "missing-condition",
        reason: "reconciliation_required",
        blockers: [
          {
            reason: "reconciliation_required",
            stage: result.stage,
            operationState: result.operationState,
          },
        ],
        operation: "attempt_dispatch",
        data: result.report,
      },
      lines: [
        `The ${result.stage} effect of this attempt is ${result.operationState}.`,
        "Run `operator attempt reconcile` before another launch step.",
      ],
    });
    return "reported";
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

  const reference = await OperativeDispatch.readReference({ worktreePath: process.cwd() });
  if (reference === null) {
    report({
      json: parsed.json,
      result: {
        outcome: "missing-condition",
        reason: "attempt_reference_missing",
        blockers: [{ reason: "attempt_reference_missing", attemptId }],
        operation: "attempt_acknowledge",
      },
      lines: [
        "This directory carries no Operator attempt reference.",
        "Acknowledge from the worktree the Operator prepared for this attempt.",
      ],
    });
    return "reported";
  }

  if (reference.attemptId !== attemptId) {
    report({
      json: parsed.json,
      result: {
        outcome: "conflict",
        reason: "attempt_reference_mismatch",
        blockers: [
          {
            reason: "attempt_reference_mismatch",
            attemptId,
            recordedAttemptId: reference.attemptId,
          },
        ],
        operation: "attempt_acknowledge",
      },
      lines: [`This worktree belongs to attempt ${reference.attemptId}.`],
    });
    return "reported";
  }

  const { result } = await CrewState.acknowledge({
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

  const { result } = await CrewState.reconcile({ projectRoot: process.cwd(), ...mutation });
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

  const { result } = await CrewState.replace({
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
    report({
      json: parsed.json,
      result: {
        outcome: "conflict",
        reason: "writer_live",
        blockers: [
          {
            reason: "writer_live",
            attemptId: result.attemptId,
            agentName: result.agentName,
            paneId: result.paneId,
          },
        ],
        operation: "attempt_replace",
      },
      lines: [
        `Operative ${result.agentName} is still live in pane ${result.paneId}.`,
        "Stop it and confirm its termination before a replacement writes.",
      ],
    });
    return "reported";
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

  const { result } = await CrewState.attempt({ projectRoot: process.cwd(), attemptId });
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

  return "invalid-arguments";
}
