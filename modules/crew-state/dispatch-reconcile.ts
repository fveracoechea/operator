import { OperativeDispatch } from "../operative-dispatch/main.ts";
import {
  type AttemptFailure,
  type DispatchReport,
  readContext,
  reportOfContext,
  type Shared,
} from "./dispatch-context.ts";
import { record } from "./operations.ts";
import { Attempt, isDispatchStage, unsettledOperations } from "./attempt-machine.ts";
import { ANSWER_DELIVERY, settleOperation } from "./dispatch.ts";
import { readState } from "./operations.ts";
import { questionByDelivery } from "./questions.ts";

type Finding = { kind: string; state: string; detail: string };

export type ReconcileResult =
  | { status: "settled"; report: DispatchReport; findings: Finding[] }
  | { status: "uncertain"; report: DispatchReport; findings: Finding[] }
  | { status: "not-dispatched"; attemptId: string }
  | AttemptFailure
  | Shared;

/**
 * True when the Operative received the answer this effect was carrying.
 * Crew state that cannot be read proves nothing, so the effect simply stays unproven.
 */
async function answerAcknowledged(projectRoot: string, operationId: string): Promise<boolean> {
  const read = await readState(projectRoot, (db) => {
    const question = questionByDelivery(db, operationId);
    return {
      status: "read" as const,
      acknowledged: question !== null && question.acknowledgedAt !== null,
    };
  });
  return read.status === "read" && read.acknowledged;
}

/**
 * Settles every unfinished external effect of one attempt.
 * An effect that stays unproven blocks this attempt instead of being repeated into a second
 * writer or a second checkout.
 */
export async function reconcileAttempt(request: {
  projectRoot: string;
  requestId: string;
  ownerToken: string;
  attemptId: string;
}): Promise<ReconcileResult> {
  // Reconciliation reads Herdr and settles records, so the current owner may run it against an
  // attempt a replaced Operator claimed. That is how a new owner learns what is still running.
  const read = await readContext(request.projectRoot, { ...request, allowStale: true });
  if (read.status !== "ok") {
    return read;
  }

  const decision = Attempt.decide("reconcile", { ...request, dispatch: read.context.dispatch });
  if ("refused" in decision) {
    return decision.refused;
  }

  const { dispatch } = decision;

  const inspection = await OperativeDispatch.inspect({
    projectRoot: request.projectRoot,
    agentName: dispatch.agentName,
    worktreePath: dispatch.worktreePath,
    baseCommit: dispatch.baseCommit,
  });

  const unsettled = unsettledOperations(read.context.operations);
  const findings: Finding[] = [];

  for (const operation of unsettled) {
    if (!isDispatchStage(operation.kind) && operation.kind !== ANSWER_DELIVERY) {
      findings.push({
        kind: operation.kind,
        state: "uncertain",
        detail: "This release does not know how to settle that effect.",
      });
      continue;
    }

    const outcome = isDispatchStage(operation.kind)
      ? Attempt.settle(operation.kind, inspection, dispatch.acknowledgedAt !== null)
      : // An answer delivery is settled by the receipt of that answer, not of the brief.
        Attempt.settleDelivery(
          inspection,
          await answerAcknowledged(request.projectRoot, operation.id),
          "answer",
        );
    findings.push({ kind: operation.kind, state: outcome.state, detail: outcome.detail });
    if (outcome.state === "uncertain") {
      continue;
    }

    const written = await record(
      {
        projectRoot: request.projectRoot,
        requestId: `${request.requestId}#${operation.id}`,
        ownerToken: request.ownerToken,
        operation: "attempt_reconcile",
        input: { operationId: operation.id, state: outcome.state, detail: outcome.detail },
      },
      ({ tx, now }) => {
        const input: Parameters<typeof settleOperation>[1] = {
          operationId: operation.id,
          attemptId: request.attemptId,
          state: outcome.state,
          detail: outcome.detail,
          now,
        };
        if (outcome.workspaceId !== undefined) input.workspaceId = outcome.workspaceId;
        if (outcome.paneId !== undefined) input.paneId = outcome.paneId;
        settleOperation(tx, input);
        return { commit: true, outcome: { status: "recorded" as const } };
      },
    );
    if (written.status !== "recorded") {
      return written;
    }
  }

  const after = await readContext(request.projectRoot, { ...request, allowStale: true });
  if (after.status !== "ok" || after.context.dispatch === null) {
    return { status: "not-dispatched", attemptId: request.attemptId };
  }

  const report = reportOfContext(after.context, after.context.dispatch);
  return findings.some((one) => one.state === "uncertain")
    ? { status: "uncertain", report, findings }
    : { status: "settled", report, findings };
}
