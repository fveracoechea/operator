import { OperativeDispatch } from "../operative-dispatch/main.ts";
import { reassignAttempt } from "./attempt.ts";
import {
  type AttemptFailure,
  type DispatchReport,
  readContext,
  reportOfContext,
  type Shared,
} from "./dispatch-context.ts";
import { unsettledOperations } from "./dispatch.ts";
import { record } from "./operations.ts";

export type AdoptResult =
  | {
      status: "adopted";
      attemptId: string;
      assignmentId: string;
      report: DispatchReport | null;
      repeated: boolean;
    }
  | { status: "already-adopted"; attemptId: string; assignmentId: string }
  | { status: "reconciliation-required"; attemptId: string; pending: string[] }
  | { status: "writer-stopped"; attemptId: string; agentName: string }
  | { status: "writer-unknown"; attemptId: string; detail: string }
  | AttemptFailure
  | Shared;

/**
 * Moves one live attempt to the Operator that owns the crew now.
 * A takeover replaces the ownership token, so every attempt the former Operator claimed stops
 * being the current writer until this session states that it read what that attempt holds.
 * Adoption runs only on an attempt whose effects are settled and whose Operative is still
 * running, because a stopped writer is replaced rather than adopted and an unproven effect is
 * reconciled first.
 */
export async function adoptAttempt(request: {
  projectRoot: string;
  requestId: string;
  ownerToken: string;
  attemptId: string;
}): Promise<AdoptResult> {
  const read = await readContext(request.projectRoot, { ...request, allowStale: true });
  if (read.status !== "ok") {
    return read;
  }

  const context = read.context;
  if (context.current) {
    return {
      status: "already-adopted",
      attemptId: request.attemptId,
      assignmentId: context.attempt.assignmentId,
    };
  }

  const pending = unsettledOperations(context.operations);
  if (pending.length > 0) {
    return {
      status: "reconciliation-required",
      attemptId: request.attemptId,
      pending: pending.map((one) => one.kind),
    };
  }

  const dispatch = context.dispatch;
  if (dispatch !== null) {
    const inspection = await OperativeDispatch.inspect({
      projectRoot: request.projectRoot,
      agentName: dispatch.agentName,
      worktreePath: dispatch.worktreePath,
      baseCommit: dispatch.baseCommit,
    });
    if (inspection.writer.state === "stopped") {
      return {
        status: "writer-stopped",
        attemptId: request.attemptId,
        agentName: dispatch.agentName,
      };
    }
    if (inspection.writer.state === "unknown") {
      return {
        status: "writer-unknown",
        attemptId: request.attemptId,
        detail: inspection.writer.detail,
      };
    }
  }

  const written = await record(
    {
      projectRoot: request.projectRoot,
      requestId: request.requestId,
      ownerToken: request.ownerToken,
      operation: "attempt_adopt",
      input: { attemptId: request.attemptId, ownerToken: request.ownerToken },
    },
    ({ tx }) => {
      reassignAttempt(tx, { attempt: context.attempt, ownerToken: request.ownerToken });
      return { commit: true, outcome: { status: "recorded" as const } };
    },
  );
  if (written.status !== "recorded") {
    return written;
  }

  return {
    status: "adopted",
    attemptId: request.attemptId,
    assignmentId: context.attempt.assignmentId,
    report: dispatch === null ? null : reportOfContext(context, dispatch),
    repeated: written.repeated,
  };
}
