import { type AttemptFailure, readContext, record, type Shared } from "./dispatch-context.ts";
import { recordAcknowledgement } from "./dispatch.ts";

export type AcknowledgeResult =
  | {
      status: "acknowledged";
      attemptId: string;
      assignmentId: string;
      worktreePath: string;
      repeated: boolean;
    }
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
    repeated: written.repeated,
  };
}
