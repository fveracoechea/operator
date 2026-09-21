import { OperativeDispatch } from "../operative-dispatch/main.ts";
import {
  type AttemptFailure,
  briefOf,
  readContext,
  record,
  type Shared,
  type Snapshot,
  type WorkInspection,
} from "./dispatch-context.ts";
import {
  endAttempt,
  openOperation,
  recordInspection,
  recordPlan,
  settleOperation,
  startAttempt,
} from "./dispatch.ts";

export type ReplaceResult =
  | {
      status: "replaced";
      previousAttemptId: string;
      attemptId: string;
      assignmentId: string;
      inspection: WorkInspection;
      repeated: boolean;
    }
  | { status: "inspection-required"; attemptId: string; inspection: WorkInspection }
  | { status: "inspection-stale"; attemptId: string; inspection: WorkInspection; approved: string }
  | { status: "writer-live"; attemptId: string; agentName: string; paneId: string }
  | { status: "writer-unknown"; attemptId: string; detail: string }
  | { status: "snapshot-unreadable"; attemptId: string; detail: string }
  | { status: "reconciliation-required"; attemptId: string; pending: string[] }
  | { status: "not-dispatched"; attemptId: string }
  | AttemptFailure
  | Shared;

/**
 * Starts a new attempt on the same assignment, keeping the inspected checkout and branch.
 * It runs only after the former writer is proven stopped and its partial work is inspected,
 * so one assignment never holds two writers.
 * An attempt a replaced Operator claimed is replaceable, because that is how the current owner
 * takes over a stopped writer.
 */
export async function replaceAttempt(request: {
  projectRoot: string;
  requestId: string;
  ownerToken: string;
  attemptId: string;
  approvedInspection: string | null;
}): Promise<ReplaceResult> {
  const read = await readContext(request.projectRoot, { ...request, allowStale: true });
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

  const restored = OperativeDispatch.readSnapshot({ recorded: dispatch.snapshot });
  if (restored.status !== "read") {
    return { status: "snapshot-unreadable", attemptId: request.attemptId, detail: restored.detail };
  }

  const snapshot: Snapshot = restored.snapshot;
  const attemptId = crypto.randomUUID();
  const launch = OperativeDispatch.plan({
    projectRoot: request.projectRoot,
    brief: briefOf(read.context.assignment, attemptId),
    snapshot,
    baseCommit: dispatch.baseCommit,
    branch: dispatch.branch,
    worktreePath: dispatch.worktreePath,
  });
  if (launch.status === "host-unnamed") {
    return {
      status: "snapshot-unreadable",
      attemptId: request.attemptId,
      detail: "The recorded snapshot names no crew host.",
    };
  }

  const previous = read.context.attempt;
  const plan = launch.plan;
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
    repeated: written.repeated,
  };
}
