import { OperativeDispatch } from "../operative-dispatch/main.ts";
import { reassignAttempt } from "./attempt.ts";
import {
  type AttemptFailure,
  type DispatchReport,
  readContext,
  reportOfContext,
  type Shared,
} from "./dispatch-context.ts";
import { Attempt, type AttemptFacts } from "./attempt-machine.ts";
import type { DispatchRow } from "./dispatch.ts";
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

/** Reads whether the Operative of a planned launch still runs, which the adopt decision asks for. */
async function gather(
  projectRoot: string,
  facts: AttemptFacts["adopt"],
  dispatch: DispatchRow,
): Promise<AttemptFacts["adopt"]> {
  const inspection = await OperativeDispatch.inspect({
    projectRoot,
    agentName: dispatch.agentName,
    worktreePath: dispatch.worktreePath,
    baseCommit: dispatch.baseCommit,
  });
  return { ...facts, inspection };
}

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
  let facts: AttemptFacts["adopt"] = { context, attemptId: request.attemptId };
  let decision = Attempt.decide("adopt", facts);
  while ("need" in decision) {
    facts = await gather(request.projectRoot, facts, decision.dispatch);
    decision = Attempt.decide("adopt", facts);
  }
  if ("refused" in decision) {
    return decision.refused;
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
    report: context.dispatch === null ? null : reportOfContext(context, context.dispatch),
    repeated: written.repeated,
  };
}
