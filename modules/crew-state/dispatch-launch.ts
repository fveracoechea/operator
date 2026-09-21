import { OperativeDispatch } from "../operative-dispatch/main.ts";
import { ProjectReadiness } from "../project-readiness/main.ts";
import {
  type AttemptFailure,
  briefOf,
  type DispatchPlan,
  type DispatchReport,
  everyStageSucceeded,
  type Overrides,
  readContext,
  reportOf,
  type Shared,
  type Snapshot,
} from "./dispatch-context.ts";
import { record } from "./operations.ts";
import {
  DISPATCH_STAGES,
  type DispatchStage,
  type OperationRow,
  openOperation,
  recordPlan,
  settleOperation,
} from "./dispatch.ts";

type SnapshotDrift = ReturnType<typeof OperativeDispatch.verifySnapshot>[number];

export type DispatchResult =
  | { status: "acknowledged"; report: DispatchReport; repeated: boolean }
  | { status: "awaiting-acknowledgement"; report: DispatchReport; repeated: boolean }
  | { status: "stage-failed"; report: DispatchReport; stage: DispatchStage; detail: string }
  | { status: "stage-uncertain"; report: DispatchReport; stage: DispatchStage; detail: string }
  | {
      status: "reconciliation-required";
      report: DispatchReport;
      stage: DispatchStage;
      operationState: string;
    }
  | { status: "snapshot-drift"; attemptId: string; drift: SnapshotDrift[] }
  | { status: "snapshot-unreadable"; attemptId: string; detail: string }
  | { status: "plan-changed"; attemptId: string; recorded: string; computed: string }
  | { status: "commit-required"; attemptId: string }
  | { status: "review-base-changed"; attemptId: string; recorded: string; requested: string }
  | { status: "host-unnamed"; attemptId: string }
  | AttemptFailure
  | Shared;

type StageOutcome =
  | { status: "succeeded"; detail: string; workspaceId?: string; paneId?: string }
  | { status: "failed"; detail: string }
  | { status: "uncertain"; detail: string };

async function runStage(request: {
  stage: DispatchStage;
  projectRoot: string;
  plan: DispatchPlan;
  snapshot: Snapshot;
  workspaceId: string | null;
}): Promise<StageOutcome> {
  const { stage, plan } = request;

  if (stage === "worktree_create") {
    const created = await OperativeDispatch.createWorktree({
      projectRoot: request.projectRoot,
      plan,
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

  if (stage === "input_preparation") {
    const prepared = await OperativeDispatch.prepare({
      projectRoot: request.projectRoot,
      plan,
      snapshot: request.snapshot,
    });
    return prepared.status === "prepared"
      ? { status: "succeeded", detail: `Copied and verified ${prepared.inputs.length} input(s).` }
      : { status: "failed", detail: `${prepared.reason}: ${prepared.detail}` };
  }

  if (stage === "agent_start") {
    if (request.workspaceId === null) {
      return { status: "failed", detail: "The recorded checkout names no Herdr workspace." };
    }

    const launched = await OperativeDispatch.launch({ plan, workspaceId: request.workspaceId });
    return launched.status === "succeeded"
      ? {
          status: "succeeded",
          detail: `Started ${plan.agentName} (${launched.value.status}).`,
          paneId: launched.value.paneId,
        }
      : launched.status === "failed"
        ? { status: "failed", detail: `${launched.code}: ${launched.detail}` }
        : { status: "uncertain", detail: launched.detail };
  }

  const delivered = await OperativeDispatch.deliver({ plan });
  return delivered.status === "succeeded"
    ? { status: "succeeded", detail: `Submitted the brief to ${plan.agentName}.` }
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

  const attemptId = read.context.attempt.id;
  const recorded = read.context.dispatch;

  // A finished launch has nothing left to perform, so a repeat reports what it recorded.
  if (recorded !== null && everyStageSucceeded(read.context.operations)) {
    const report = reportOf({
      attempt: read.context.attempt,
      dispatch: recorded,
      operations: read.context.operations,
      acknowledged: recorded.acknowledgedAt !== null,
    });
    return recorded.acknowledgedAt !== null
      ? { status: "acknowledged", report, repeated: true }
      : { status: "awaiting-acknowledgement", report, repeated: true };
  }

  const current = await ProjectReadiness.snapshot({
    projectRoot: request.projectRoot,
    overrides: request.overrides,
  });

  let snapshot: Snapshot = current;
  if (recorded !== null) {
    const restored = OperativeDispatch.readSnapshot({ recorded: recorded.snapshot });
    if (restored.status !== "read") {
      return { status: "snapshot-unreadable", attemptId, detail: restored.detail };
    }

    snapshot = restored.snapshot;
    const drift = OperativeDispatch.verifySnapshot({ recorded: snapshot, current });
    if (drift.length > 0) {
      return { status: "snapshot-drift", attemptId, drift };
    }
  }

  const baseCommit = recorded?.baseCommit ?? request.baseCommit;
  if (baseCommit === null) {
    return { status: "commit-required", attemptId };
  }

  // A review reads the exact commit the result was submitted on, never a later one.
  const reviewBase = read.context.review?.submission.reviewBase ?? null;
  if (reviewBase !== null && baseCommit !== reviewBase) {
    return {
      status: "review-base-changed",
      attemptId,
      recorded: reviewBase,
      requested: baseCommit,
    };
  }

  // A recorded launch keeps the inputs it was planned with, so a request that names different
  // ones is a conflict rather than a silently ignored argument.
  const changed =
    recorded === null
      ? undefined
      : (
          [
            [request.baseCommit, baseCommit],
            [request.branch, recorded.branch],
            [request.worktreePath, recorded.worktreePath],
          ] satisfies Array<[string | null, string]>
        ).find(([asked, held]) => asked !== null && asked !== held);
  if (changed !== undefined) {
    return { status: "plan-changed", attemptId, recorded: changed[1], computed: changed[0] ?? "" };
  }

  const launch = OperativeDispatch.plan({
    projectRoot: request.projectRoot,
    brief: briefOf(read.context.assignment, attemptId, read.context.review),
    snapshot,
    baseCommit,
    branch: recorded?.branch ?? request.branch,
    worktreePath: recorded?.worktreePath ?? request.worktreePath,
  });
  if (launch.status === "host-unnamed") {
    return { status: "host-unnamed", attemptId };
  }

  const plan = launch.plan;
  if (recorded !== null && recorded.promptIdentity !== plan.promptIdentity) {
    // The brief is fixed at dispatch, so a recomputed brief that differs is never delivered.
    return {
      status: "plan-changed",
      attemptId,
      recorded: recorded.promptIdentity,
      computed: plan.promptIdentity,
    };
  }

  if (recorded === null) {
    const written = await record(
      {
        projectRoot: request.projectRoot,
        requestId: `${request.requestId}#plan`,
        ownerToken: request.ownerToken,
        operation: "attempt_dispatch_plan",
        input: { attemptId, plan: plan.promptIdentity },
      },
      ({ tx, now }) => {
        recordPlan(tx, {
          attemptId,
          assignmentId: read.context.attempt.assignmentId,
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
  }

  const planned = await readContext(request.projectRoot, request);
  if (planned.status !== "ok") {
    return planned;
  }
  const dispatchRow = planned.context.dispatch;
  if (dispatchRow === null) {
    return { status: "unknown-attempt", attemptId };
  }

  const dispatch = dispatchRow;
  const attempt = planned.context.attempt;
  const operations = new Map(planned.context.operations.map((one) => [one.kind, one]));
  let workspaceId = dispatch.workspaceId;

  function report(acknowledged = false): DispatchReport {
    return reportOf({
      attempt,
      dispatch,
      operations: [...operations.values()],
      acknowledged,
    });
  }

  for (const stage of DISPATCH_STAGES) {
    const existing = operations.get(stage) ?? null;
    if (existing?.state === "succeeded") {
      continue;
    }

    // A Herdr effect that never settled may have landed, so it is reconciled, never repeated.
    const reusable = stage === "input_preparation" && existing?.state === "intended";
    if (existing !== null && !reusable) {
      return {
        status: "reconciliation-required",
        report: report(),
        stage,
        operationState: existing.state,
      };
    }

    // The recorded effects decide what runs again, so each pass carries its own identity and a
    // repeated dispatch is never mistaken for a replay of the stage it is about to perform.
    const pass = crypto.randomUUID();
    const operationId = existing?.id ?? pass;
    if (existing === null) {
      const opened = await record(
        {
          projectRoot: request.projectRoot,
          requestId: `${request.requestId}#${stage}.${pass}.open`,
          ownerToken: request.ownerToken,
          operation: "attempt_dispatch_stage",
          input: { attemptId, stage, operationId },
        },
        ({ tx, now }) => {
          openOperation(tx, {
            operationId,
            attemptId,
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
        requestId: `${request.requestId}#${stage}.${pass}.settle`,
        ownerToken: request.ownerToken,
        operation: "attempt_dispatch_stage_result",
        input: { operationId, state: outcome.status, detail: outcome.detail },
      },
      ({ tx, now }) => {
        settleOperation(tx, {
          operationId,
          attemptId,
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

    const kept: OperationRow = {
      ...(existing ?? {
        id: operationId,
        attemptId,
        kind: stage,
        requestId: request.requestId,
        intent: JSON.stringify({ stage, plan: plan.promptIdentity }),
        startedAt: "",
        settledAt: null,
      }),
      state: outcome.status,
      detail: outcome.detail,
    };
    operations.set(stage, kept);

    if (outcome.status === "succeeded" && outcome.workspaceId !== undefined) {
      workspaceId = outcome.workspaceId;
    }
    if (outcome.status === "failed") {
      return { status: "stage-failed", report: report(), stage, detail: outcome.detail };
    }
    if (outcome.status === "uncertain") {
      return { status: "stage-uncertain", report: report(), stage, detail: outcome.detail };
    }
  }

  // The Operative can acknowledge while this dispatch is still delivering, so the answer is read
  // from the state rather than from what this call knew when it started.
  const final = await readContext(request.projectRoot, request);
  const acknowledged = final.status === "ok" && final.context.dispatch?.acknowledgedAt !== null;

  return acknowledged
    ? { status: "acknowledged", report: report(true), repeated: false }
    : { status: "awaiting-acknowledgement", report: report(), repeated: false };
}
