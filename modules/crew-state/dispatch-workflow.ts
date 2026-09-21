import { OperativeDispatch } from "../operative-dispatch/main.ts";
import { ProjectReadiness } from "../project-readiness/main.ts";
import {
  type AssignmentRow,
  type AttemptContext,
  type AttemptLookup,
  DISPATCH_STAGES,
  type DispatchStage,
  dispatchStage,
  endAttempt,
  lookupAttempt,
  type OperationRow,
  openOperation,
  operationFor,
  recordAcknowledgement,
  recordInspection,
  recordPlan,
  settleOperation,
  startAttempt,
} from "./dispatch.ts";
import { type RequestFailure, mutate, readState, type StateFailure } from "./operations.ts";
import { requireOwnership } from "./ownership.ts";

type Overrides = Parameters<typeof ProjectReadiness.snapshot>[0]["overrides"];

// A module states its shapes through its own interface, so these follow the dispatch methods.
type PlanRequest = Parameters<typeof OperativeDispatch.plan>[0];
type Brief = PlanRequest["brief"];
type Snapshot = PlanRequest["snapshot"];
type DispatchPlan = Extract<
  ReturnType<typeof OperativeDispatch.plan>,
  { status: "planned" }
>["plan"];
type SnapshotDrift = ReturnType<typeof OperativeDispatch.verifySnapshot>[number];
type Inspection = Awaited<ReturnType<typeof OperativeDispatch.inspect>>;
type WorkInspection = Inspection["work"];

type AttemptFailure = Exclude<AttemptLookup, { status: "ok" }>;

type Shared = StateFailure | RequestFailure;

export type DispatchResult =
  | { status: "acknowledged"; report: DispatchReport }
  | { status: "awaiting-acknowledgement"; report: DispatchReport }
  | { status: "stage-failed"; report: DispatchReport; stage: DispatchStage; detail: string }
  | { status: "stage-uncertain"; report: DispatchReport; stage: DispatchStage; detail: string }
  | {
      status: "reconciliation-required";
      report: DispatchReport;
      stage: DispatchStage;
      operationState: string;
    }
  | { status: "snapshot-drift"; attemptId: string; drift: SnapshotDrift[] }
  | { status: "plan-changed"; attemptId: string; recorded: string; computed: string }
  | { status: "commit-required"; attemptId: string }
  | { status: "host-unnamed"; attemptId: string }
  | AttemptFailure
  | Shared;

export type DispatchReport = {
  attemptId: string;
  assignmentId: string;
  stage: string;
  branch: string;
  baseCommit: string;
  worktreePath: string;
  agentName: string;
  agentHost: string;
  promptIdentity: string;
  snapshotIdentity: string;
  operations: Array<{ kind: string; state: string; detail: string | null }>;
};

function briefOf(assignment: AssignmentRow, attemptId: string): Brief {
  return {
    assignmentId: assignment.id,
    attemptId,
    sourceId: assignment.sourceId,
    sourceKey: assignment.sourceKey,
    sourceRevision: assignment.sourceRevision,
    title: assignment.title,
    kind: assignment.kind,
    approvedScope: assignment.approvedScope,
    acceptanceRequirements: JSON.parse(assignment.acceptanceRequirements),
    permissions: JSON.parse(assignment.permissions),
    fixedInputs: JSON.parse(assignment.fixedInputs),
  };
}

function reportOf(context: AttemptContext, operations: OperationRow[]): DispatchReport {
  const dispatch = context.dispatch;

  return {
    attemptId: context.attempt.id,
    assignmentId: context.attempt.assignmentId,
    stage: dispatchStage({ ...context, operations }),
    branch: dispatch?.branch ?? "",
    baseCommit: dispatch?.baseCommit ?? "",
    worktreePath: dispatch?.worktreePath ?? "",
    agentName: dispatch?.agentName ?? "",
    agentHost: dispatch?.agentHost ?? "",
    promptIdentity: dispatch?.promptIdentity ?? "",
    snapshotIdentity: dispatch?.snapshotIdentity ?? "",
    operations: operations.map((one) => ({
      kind: one.kind,
      state: one.state,
      detail: one.detail,
    })),
  };
}

/**
 * Reads one attempt under the ownership the caller claims.
 * A command that finds every stage already finished performs no mutation, so ownership is
 * checked here rather than only inside a write.
 */
async function readContext(
  projectRoot: string,
  request: { attemptId: string; ownerToken: string | null },
): Promise<
  { status: "ok"; context: AttemptContext } | AttemptFailure | StateFailure | RequestFailure
> {
  return readState(projectRoot, (db) => {
    if (request.ownerToken !== null) {
      const check = requireOwnership(db, request.ownerToken);
      if (check.status === "unowned") {
        return { status: "unowned" as const };
      }
      if (check.status === "stale") {
        return { status: "ownership-stale" as const, ownership: check.ownership };
      }
    }

    const found = lookupAttempt(db, request.attemptId);
    return found.status === "ok" && !found.context.current
      ? { status: "attempt-not-current" as const, attemptId: request.attemptId }
      : found;
  });
}

/** A sub-mutation of one dispatch. Only its own success continues the sequence. */
async function record(
  request: {
    projectRoot: string;
    requestId: string;
    ownerToken: string | null;
    operation: string;
    input: unknown;
  },
  body: Parameters<typeof mutate<{ status: "recorded" }>>[1],
): Promise<{ status: "recorded" } | Shared> {
  const { result } = await mutate<{ status: "recorded" }>(
    { ...request, now: new Date().toISOString() },
    body,
  );
  return result;
}

type StageOutcome =
  | { status: "succeeded"; detail: string; workspaceId?: string | null; paneId?: string | null }
  | { status: "failed"; detail: string }
  | { status: "uncertain"; detail: string };

async function runStage(request: {
  stage: DispatchStage;
  projectRoot: string;
  plan: DispatchPlan;
  snapshot: Snapshot;
  workspaceId: string | null;
}): Promise<StageOutcome> {
  if (request.stage === "worktree_create") {
    const created = await OperativeDispatch.createWorktree({
      projectRoot: request.projectRoot,
      plan: request.plan,
    });
    return created.status === "succeeded"
      ? {
          status: "succeeded",
          detail: `Created ${created.value.worktreePath}.`,
          workspaceId: created.value.workspaceId,
        }
      : created.status === "failed"
        ? { status: "failed", detail: `${created.code}: ${created.detail}` }
        : { status: "uncertain", detail: created.detail };
  }

  if (request.stage === "input_preparation") {
    const prepared = await OperativeDispatch.prepare({
      projectRoot: request.projectRoot,
      plan: request.plan,
      snapshot: request.snapshot,
    });
    return prepared.status === "prepared"
      ? { status: "succeeded", detail: `Copied and verified ${prepared.inputs.length} input(s).` }
      : { status: "failed", detail: `${prepared.reason}: ${prepared.detail}` };
  }

  if (request.stage === "agent_start") {
    if (request.workspaceId === null) {
      return { status: "failed", detail: "The recorded checkout names no Herdr workspace." };
    }

    const launched = await OperativeDispatch.launch({
      plan: request.plan,
      workspaceId: request.workspaceId,
    });
    return launched.status === "succeeded"
      ? {
          status: "succeeded",
          detail: `Started ${request.plan.agentName} (${launched.value.status}).`,
          paneId: launched.value.paneId,
        }
      : launched.status === "failed"
        ? { status: "failed", detail: `${launched.code}: ${launched.detail}` }
        : { status: "uncertain", detail: launched.detail };
  }

  const delivered = await OperativeDispatch.deliver({ plan: request.plan });
  return delivered.status === "succeeded"
    ? { status: "succeeded", detail: `Submitted the brief to ${request.plan.agentName}.` }
    : delivered.status === "failed"
      ? { status: "failed", detail: `${delivered.code}: ${delivered.detail}` }
      : { status: "uncertain", detail: delivered.detail };
}

/**
 * Dispatches one claimed assignment to an isolated Operative.
 * Every stage records its intent before it acts and its outcome after, so an interrupted launch
 * is reconciled against Herdr instead of being repeated into a second writer.
 */
export async function dispatchAttempt(request: {
  projectRoot: string;
  requestId: string;
  ownerToken: string;
  attemptId: string;
  baseCommit: string | null;
  branch: string | null;
  worktreePath: string | null;
  overrides: Overrides;
}): Promise<DispatchResult> {
  const read = await readContext(request.projectRoot, request);
  if (read.status !== "ok") {
    return read;
  }

  const context = read.context;
  const current = await ProjectReadiness.snapshot({
    projectRoot: request.projectRoot,
    overrides: request.overrides,
  });

  const recorded = context.dispatch;
  const snapshot: Snapshot = recorded === null ? current : JSON.parse(recorded.snapshot);
  if (recorded !== null) {
    const drift = OperativeDispatch.verifySnapshot({ recorded: snapshot, current });
    if (drift.length > 0) {
      return { status: "snapshot-drift", attemptId: context.attempt.id, drift };
    }
  }

  const baseCommit = recorded?.baseCommit ?? request.baseCommit;
  if (baseCommit === null) {
    return { status: "commit-required", attemptId: context.attempt.id };
  }

  const planned = OperativeDispatch.plan({
    projectRoot: request.projectRoot,
    brief: briefOf(context.assignment, context.attempt.id),
    snapshot,
    baseCommit,
    branch: recorded?.branch ?? request.branch,
    worktreePath: recorded?.worktreePath ?? request.worktreePath,
  });
  if (planned.status === "host-unnamed") {
    return { status: "host-unnamed", attemptId: context.attempt.id };
  }

  const plan = planned.plan;
  if (recorded !== null && recorded.promptIdentity !== plan.promptIdentity) {
    // The brief is fixed at dispatch, so a recomputed brief that differs is never delivered.
    return {
      status: "plan-changed",
      attemptId: context.attempt.id,
      recorded: recorded.promptIdentity,
      computed: plan.promptIdentity,
    };
  }
  if (recorded !== null && request.baseCommit !== null && request.baseCommit !== baseCommit) {
    return {
      status: "plan-changed",
      attemptId: context.attempt.id,
      recorded: baseCommit,
      computed: request.baseCommit,
    };
  }

  if (recorded === null) {
    const written = await record(
      {
        projectRoot: request.projectRoot,
        requestId: `${request.requestId}#plan`,
        ownerToken: request.ownerToken,
        operation: "attempt_dispatch_plan",
        input: { attemptId: context.attempt.id, plan: plan.promptIdentity },
      },
      ({ tx, now }) => {
        recordPlan(tx, {
          attemptId: context.attempt.id,
          assignmentId: context.attempt.assignmentId,
          baseCommit: plan.baseCommit,
          branch: plan.branch,
          worktreePath: plan.worktreePath,
          snapshot,
          snapshotIdentity: plan.snapshotIdentity,
          briefIdentity: plan.briefIdentity,
          promptIdentity: plan.promptIdentity,
          agentName: plan.agentName,
          agentKind: plan.agentKind,
          agentHost: plan.agentHost,
          workspaceId: null,
          now,
        });
        return { commit: true, outcome: { status: "recorded" as const } };
      },
    );
    if (written.status !== "recorded") {
      return written;
    }

    context.dispatch = await readContext(request.projectRoot, request).then((again) =>
      again.status === "ok" ? again.context.dispatch : null,
    );
  }

  const operations = [...context.operations];
  let workspaceId = context.dispatch?.workspaceId ?? null;

  for (const stage of DISPATCH_STAGES) {
    const existing = operationFor(operations, stage);
    if (existing?.state === "succeeded") {
      continue;
    }

    // A Herdr effect that never settled may have landed, so it is reconciled, never repeated.
    const reusable = stage === "input_preparation" && existing?.state === "intended";
    if (existing !== null && !reusable) {
      return {
        status: "reconciliation-required",
        report: reportOf(context, operations),
        stage,
        operationState: existing.state,
      };
    }

    const operationId = existing?.id ?? crypto.randomUUID();
    if (existing === null) {
      const opened = await record(
        {
          projectRoot: request.projectRoot,
          requestId: `${request.requestId}#${stage}.open`,
          ownerToken: request.ownerToken,
          operation: "attempt_dispatch_stage",
          input: { attemptId: context.attempt.id, stage, operationId },
        },
        ({ tx, now }) => {
          openOperation(tx, {
            operationId,
            attemptId: context.attempt.id,
            kind: stage,
            requestId: request.requestId,
            intent: { stage, plan: plan.promptIdentity },
            now,
          });
          return { commit: true, outcome: { status: "recorded" as const } };
        },
      );
      if (opened.status !== "recorded") {
        return opened;
      }
    }

    const outcome = await runStage({
      stage,
      projectRoot: request.projectRoot,
      plan,
      snapshot,
      workspaceId,
    });

    const settled = await record(
      {
        projectRoot: request.projectRoot,
        requestId: `${request.requestId}#${stage}.settle`,
        ownerToken: request.ownerToken,
        operation: "attempt_dispatch_stage_result",
        input: { operationId, state: outcome.status, detail: outcome.detail },
      },
      ({ tx, now }) => {
        settleOperation(tx, {
          operationId,
          attemptId: context.attempt.id,
          state: outcome.status,
          detail: outcome.detail,
          ...(outcome.status === "succeeded" && outcome.workspaceId !== undefined
            ? { workspaceId: outcome.workspaceId }
            : {}),
          ...(outcome.status === "succeeded" && outcome.paneId !== undefined
            ? { paneId: outcome.paneId }
            : {}),
          now,
        });
        return { commit: true, outcome: { status: "recorded" as const } };
      },
    );
    if (settled.status !== "recorded") {
      return settled;
    }

    const settledRow: OperationRow = {
      id: operationId,
      attemptId: context.attempt.id,
      kind: stage,
      requestId: request.requestId,
      intent: "",
      state: outcome.status,
      detail: outcome.detail,
      startedAt: "",
      settledAt: "",
    };
    const index = operations.findIndex((one) => one.kind === stage);
    if (index === -1) {
      operations.push(settledRow);
    } else {
      operations[index] = settledRow;
    }

    if (outcome.status === "succeeded" && outcome.workspaceId !== undefined) {
      workspaceId = outcome.workspaceId;
    }
    if (outcome.status === "failed") {
      return {
        status: "stage-failed",
        report: reportOf(context, operations),
        stage,
        detail: outcome.detail,
      };
    }
    if (outcome.status === "uncertain") {
      return {
        status: "stage-uncertain",
        report: reportOf(context, operations),
        stage,
        detail: outcome.detail,
      };
    }
  }

  const final = await readContext(request.projectRoot, request);
  const acknowledged = final.status === "ok" && final.context.dispatch?.acknowledgedAt !== null;
  const report = reportOf(final.status === "ok" ? final.context : context, operations);

  return acknowledged
    ? { status: "acknowledged", report }
    : { status: "awaiting-acknowledgement", report };
}

export type AcknowledgeResult =
  | { status: "acknowledged"; attemptId: string; assignmentId: string; worktreePath: string }
  | { status: "already-acknowledged"; attemptId: string; acknowledgedAt: string }
  | { status: "not-dispatched"; attemptId: string }
  | { status: "reference-mismatch"; attemptId: string; detail: string }
  | AttemptFailure
  | Shared;

/**
 * Records the Operative's own acknowledgement of its assignment.
 * It carries no ownership token, so the attempt it names must still be the current writer.
 */
export async function acknowledgeAttempt(request: {
  projectRoot: string;
  requestId: string;
  attemptId: string;
  worktreePath: string;
}): Promise<AcknowledgeResult> {
  const read = await readContext(request.projectRoot, {
    attemptId: request.attemptId,
    ownerToken: null,
  });
  if (read.status !== "ok") {
    return read;
  }

  const dispatch = read.context.dispatch;
  if (dispatch === null) {
    return { status: "not-dispatched", attemptId: request.attemptId };
  }
  if (dispatch.worktreePath !== request.worktreePath) {
    return {
      status: "reference-mismatch",
      attemptId: request.attemptId,
      detail: `This attempt is recorded against ${dispatch.worktreePath}.`,
    };
  }
  if (dispatch.acknowledgedAt !== null) {
    return {
      status: "already-acknowledged",
      attemptId: request.attemptId,
      acknowledgedAt: dispatch.acknowledgedAt,
    };
  }

  const operations = read.context.operations;
  const written = await record(
    {
      projectRoot: request.projectRoot,
      requestId: request.requestId,
      ownerToken: null,
      operation: "attempt_acknowledge",
      input: { attemptId: request.attemptId, worktreePath: request.worktreePath },
    },
    ({ tx, now }) => {
      recordAcknowledgement(tx, { attemptId: request.attemptId, operations, now });
      return { commit: true, outcome: { status: "recorded" as const } };
    },
  );
  if (written.status !== "recorded") {
    return written;
  }

  return {
    status: "acknowledged",
    attemptId: request.attemptId,
    assignmentId: read.context.attempt.assignmentId,
    worktreePath: dispatch.worktreePath,
  };
}

export type ReconcileResult =
  | { status: "settled"; report: DispatchReport; findings: Finding[] }
  | { status: "uncertain"; report: DispatchReport; findings: Finding[] }
  | { status: "not-dispatched"; attemptId: string }
  | AttemptFailure
  | Shared;

type Finding = { kind: string; state: string; detail: string };

/**
 * Settles every unfinished external effect of one attempt from what Herdr and the checkout show.
 * A timeout never proves non-delivery, so an effect that stays unproven blocks this attempt
 * instead of being repeated.
 */
export async function reconcileAttempt(request: {
  projectRoot: string;
  requestId: string;
  ownerToken: string;
  attemptId: string;
}): Promise<ReconcileResult> {
  const read = await readContext(request.projectRoot, request);
  if (read.status !== "ok") {
    return read;
  }

  const dispatch = read.context.dispatch;
  if (dispatch === null) {
    return { status: "not-dispatched", attemptId: request.attemptId };
  }

  const inspection = await OperativeDispatch.inspect({
    projectRoot: request.projectRoot,
    agentName: dispatch.agentName,
    worktreePath: dispatch.worktreePath,
    baseCommit: dispatch.baseCommit,
  });

  const unsettled = read.context.operations.filter(
    (one) => one.state === "intended" || one.state === "uncertain",
  );
  const findings: Finding[] = [];

  for (const operation of unsettled) {
    const outcome = settleFrom(operation.kind, inspection, dispatch.acknowledgedAt !== null);
    findings.push({ kind: operation.kind, state: outcome.state, detail: outcome.detail });
    if (outcome.state === "uncertain") {
      continue;
    }

    const written = await record(
      {
        projectRoot: request.projectRoot,
        requestId: `${request.requestId}#${operation.kind}`,
        ownerToken: request.ownerToken,
        operation: "attempt_reconcile",
        input: { operationId: operation.id, state: outcome.state, detail: outcome.detail },
      },
      ({ tx, now }) => {
        settleOperation(tx, {
          operationId: operation.id,
          attemptId: request.attemptId,
          state: outcome.state,
          detail: outcome.detail,
          ...(outcome.workspaceId === undefined ? {} : { workspaceId: outcome.workspaceId }),
          ...(outcome.paneId === undefined ? {} : { paneId: outcome.paneId }),
          now,
        });
        return { commit: true, outcome: { status: "recorded" as const } };
      },
    );
    if (written.status !== "recorded") {
      return written;
    }
  }

  const after = await readContext(request.projectRoot, request);
  const context = after.status === "ok" ? after.context : read.context;
  const report = reportOf(context, context.operations);

  return findings.some((one) => one.state === "uncertain")
    ? { status: "uncertain", report, findings }
    : { status: "settled", report, findings };
}

function settleFrom(
  kind: string,
  inspection: Inspection,
  acknowledged: boolean,
): {
  state: "succeeded" | "failed" | "uncertain";
  detail: string;
  workspaceId?: string | null;
  paneId?: string | null;
} {
  if (kind === "worktree_create") {
    if (inspection.checkout.state === "unknown") {
      return { state: "uncertain", detail: inspection.checkout.detail };
    }
    if (inspection.checkout.state === "absent") {
      return { state: "failed", detail: "Herdr holds no checkout at the recorded path." };
    }

    return { state: "succeeded", detail: "The recorded checkout exists." };
  }

  if (kind === "input_preparation") {
    // Copying is verified and repeatable, so an unfinished copy is simply performed again.
    return { state: "failed", detail: "The input copy did not finish, so it runs again." };
  }

  if (kind === "agent_start") {
    if (inspection.writer.state === "unknown") {
      return { state: "uncertain", detail: inspection.writer.detail };
    }
    if (inspection.writer.state === "stopped") {
      return { state: "failed", detail: "Herdr holds no agent under the recorded name." };
    }

    return {
      state: "succeeded",
      detail: `The recorded agent is live (${inspection.writer.status}).`,
      paneId: inspection.writer.paneId,
    };
  }

  if (acknowledged) {
    return { state: "succeeded", detail: "The Operative acknowledged the assignment." };
  }
  if (inspection.writer.state === "stopped") {
    return { state: "failed", detail: "The agent that would have received the brief is gone." };
  }

  return {
    state: "uncertain",
    detail:
      "The brief may have reached a live Operative that has not acknowledged it. A timeout does not prove non-delivery.",
  };
}

export type ReplaceResult =
  | {
      status: "replaced";
      previousAttemptId: string;
      attemptId: string;
      assignmentId: string;
      inspection: WorkInspection;
    }
  | { status: "inspection-required"; attemptId: string; inspection: WorkInspection }
  | {
      status: "inspection-stale";
      attemptId: string;
      inspection: WorkInspection;
      approved: string;
    }
  | { status: "writer-live"; attemptId: string; agentName: string; paneId: string }
  | { status: "writer-unknown"; attemptId: string; detail: string }
  | { status: "reconciliation-required"; attemptId: string; pending: string[] }
  | { status: "not-dispatched"; attemptId: string }
  | AttemptFailure
  | Shared;

/**
 * Starts a new attempt on the same assignment, keeping the inspected checkout and branch.
 * It runs only after the former writer is proven stopped and its partial work was inspected,
 * so one assignment never holds two writers.
 */
export async function replaceAttempt(request: {
  projectRoot: string;
  requestId: string;
  ownerToken: string;
  attemptId: string;
  approvedInspection: string | null;
}): Promise<ReplaceResult> {
  const read = await readContext(request.projectRoot, request);
  if (read.status !== "ok") {
    return read;
  }

  const dispatch = read.context.dispatch;
  if (dispatch === null) {
    return { status: "not-dispatched", attemptId: request.attemptId };
  }

  const pending = read.context.operations.filter(
    (one) => one.state === "intended" || one.state === "uncertain",
  );
  if (pending.length > 0) {
    return {
      status: "reconciliation-required",
      attemptId: request.attemptId,
      pending: pending.map((one) => one.kind),
    };
  }

  const inspection = await OperativeDispatch.inspect({
    projectRoot: request.projectRoot,
    agentName: dispatch.agentName,
    worktreePath: dispatch.worktreePath,
    baseCommit: dispatch.baseCommit,
  });
  if (inspection.writer.state === "live") {
    return {
      status: "writer-live",
      attemptId: request.attemptId,
      agentName: dispatch.agentName,
      paneId: inspection.writer.paneId,
    };
  }
  if (inspection.writer.state === "unknown") {
    return {
      status: "writer-unknown",
      attemptId: request.attemptId,
      detail: inspection.writer.detail,
    };
  }

  if (request.approvedInspection === null) {
    return {
      status: "inspection-required",
      attemptId: request.attemptId,
      inspection: inspection.work,
    };
  }
  if (request.approvedInspection !== inspection.work.identity) {
    return {
      status: "inspection-stale",
      attemptId: request.attemptId,
      inspection: inspection.work,
      approved: request.approvedInspection,
    };
  }

  const attemptId = crypto.randomUUID();
  const snapshot: Snapshot = JSON.parse(dispatch.snapshot);
  const planned = OperativeDispatch.plan({
    projectRoot: request.projectRoot,
    brief: briefOf(read.context.assignment, attemptId),
    snapshot,
    baseCommit: dispatch.baseCommit,
    branch: dispatch.branch,
    worktreePath: dispatch.worktreePath,
  });
  if (planned.status === "host-unnamed") {
    return {
      status: "writer-unknown",
      attemptId: request.attemptId,
      detail: "The recorded snapshot names no crew host.",
    };
  }

  const previous = read.context.attempt;
  const written = await record(
    {
      projectRoot: request.projectRoot,
      requestId: request.requestId,
      ownerToken: request.ownerToken,
      operation: "attempt_replace",
      input: { attemptId: request.attemptId, inspection: inspection.work.identity },
    },
    ({ tx, now }) => {
      recordInspection(tx, {
        attemptId: previous.id,
        inspection: inspection.work,
        identity: inspection.work.identity,
        now,
      });
      endAttempt(tx, { attempt: previous, state: "replaced", now });
      startAttempt(tx, {
        attemptId,
        assignmentId: previous.assignmentId,
        ownerToken: request.ownerToken,
        now,
      });
      recordPlan(tx, {
        attemptId,
        assignmentId: previous.assignmentId,
        baseCommit: planned.plan.baseCommit,
        branch: planned.plan.branch,
        worktreePath: planned.plan.worktreePath,
        snapshot,
        snapshotIdentity: planned.plan.snapshotIdentity,
        briefIdentity: planned.plan.briefIdentity,
        promptIdentity: planned.plan.promptIdentity,
        agentName: planned.plan.agentName,
        agentKind: planned.plan.agentKind,
        agentHost: planned.plan.agentHost,
        // The inspected checkout is retained, so the replacement never creates a second one.
        workspaceId: dispatch.workspaceId,
        now,
      });
      const retained = crypto.randomUUID();
      openOperation(tx, {
        operationId: retained,
        attemptId,
        kind: "worktree_create",
        requestId: request.requestId,
        intent: { stage: "worktree_create", retained: dispatch.worktreePath },
        now,
      });
      settleOperation(tx, {
        operationId: retained,
        attemptId,
        state: "succeeded",
        detail: `Retained the inspected checkout at ${dispatch.worktreePath}.`,
        now,
      });
      return { commit: true, outcome: { status: "recorded" as const } };
    },
  );
  if (written.status !== "recorded") {
    return written;
  }

  return {
    status: "replaced",
    previousAttemptId: previous.id,
    attemptId,
    assignmentId: previous.assignmentId,
    inspection: inspection.work,
  };
}

export type ShowResult =
  | {
      status: "reported";
      report: DispatchReport;
      acknowledgedAt: string | null;
      current: boolean;
    }
  | { status: "not-dispatched"; attemptId: string }
  | AttemptFailure
  | Shared;

export async function showAttempt(request: {
  projectRoot: string;
  attemptId: string;
}): Promise<ShowResult> {
  // A report is a read anyone may run, so it describes a stale attempt instead of refusing it.
  const read = await readState(request.projectRoot, (db) => lookupAttempt(db, request.attemptId));
  if (read.status !== "ok") {
    return read;
  }
  if (read.context.dispatch === null) {
    return { status: "not-dispatched", attemptId: request.attemptId };
  }

  return {
    status: "reported",
    report: reportOf(read.context, read.context.operations),
    acknowledgedAt: read.context.dispatch.acknowledgedAt,
    current: read.context.current,
  };
}
