import { OperativeDispatch } from "../operative-dispatch/main.ts";
import {
  type AttemptFailure,
  type DispatchReport,
  type Inspection,
  readContext,
  record,
  reportOfContext,
  type Shared,
} from "./dispatch-context.ts";
import {
  ANSWER_DELIVERY,
  type DispatchStage,
  isDispatchStage,
  type OperationState,
  settleOperation,
} from "./dispatch.ts";
import { readState } from "./operations.ts";
import { questionByDelivery } from "./questions.ts";

type Finding = { kind: string; state: string; detail: string };

export type ReconcileResult =
  | { status: "settled"; report: DispatchReport; findings: Finding[] }
  | { status: "uncertain"; report: DispatchReport; findings: Finding[] }
  | { status: "not-dispatched"; attemptId: string }
  | AttemptFailure
  | Shared;

type Settlement = {
  state: Exclude<OperationState, "intended">;
  detail: string;
  workspaceId?: string;
  paneId?: string;
};

/**
 * Decides one unfinished effect from what Herdr and the checkout show.
 * A timeout never proves non-delivery, so an effect that stays unproven is left open.
 */
function settleFrom(
  stage: DispatchStage,
  inspection: Inspection,
  acknowledged: boolean,
): Settlement {
  if (stage === "worktree_create") {
    if (inspection.checkout.state === "unknown") {
      return { state: "uncertain", detail: inspection.checkout.detail };
    }

    return inspection.checkout.state === "absent"
      ? { state: "failed", detail: "Herdr holds no checkout at the recorded path." }
      : { state: "succeeded", detail: "The recorded checkout exists." };
  }

  if (stage === "input_preparation") {
    // Copying is verified and repeatable, so an unfinished copy is simply performed again.
    return { state: "failed", detail: "The input copy did not finish, so it runs again." };
  }

  if (stage === "agent_start") {
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

  return settleDelivery(inspection, acknowledged, "assignment");
}

/**
 * Decides one unproven submission from what the writer shows.
 * The Operative's own receipt is the only proof of arrival, and a timeout proves nothing.
 */
function settleDelivery(
  inspection: Inspection,
  acknowledged: boolean,
  subject: "assignment" | "answer",
): Settlement {
  if (acknowledged) {
    return { state: "succeeded", detail: `The Operative acknowledged the ${subject}.` };
  }
  if (inspection.writer.state === "stopped") {
    return {
      state: "failed",
      detail: `The agent that would have received the ${subject} is gone.`,
    };
  }

  return {
    state: "uncertain",
    detail: `The ${subject} may have reached a live Operative that has not acknowledged it. A timeout does not prove non-delivery.`,
  };
}

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
    if (!isDispatchStage(operation.kind) && operation.kind !== ANSWER_DELIVERY) {
      findings.push({
        kind: operation.kind,
        state: "uncertain",
        detail: "This release does not know how to settle that effect.",
      });
      continue;
    }

    const outcome = isDispatchStage(operation.kind)
      ? settleFrom(operation.kind, inspection, dispatch.acknowledgedAt !== null)
      : // An answer delivery is settled by the receipt of that answer, not of the brief.
        settleDelivery(
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

  const after = await readContext(request.projectRoot, { ...request, allowStale: true });
  if (after.status !== "ok" || after.context.dispatch === null) {
    return { status: "not-dispatched", attemptId: request.attemptId };
  }

  const report = reportOfContext(after.context, after.context.dispatch);
  return findings.some((one) => one.state === "uncertain")
    ? { status: "uncertain", report, findings }
    : { status: "settled", report, findings };
}
