import { OperativeDispatch } from "../operative-dispatch/main.ts";
import { type AttemptFailure, readContext, type Shared } from "./dispatch-context.ts";
import { record } from "./operations.ts";
import {
  ANSWER_DELIVERY,
  openOperation,
  type OperationRow,
  readOperation,
  settleOperation,
} from "./dispatch.ts";
import { mutate, readState } from "./operations.ts";
import {
  type AnswerRow,
  answerRecordOf,
  findAnswer,
  findQuestion,
  readQuestion,
  type QuestionRow,
  recordDelivered,
  recordDeliveryIntent,
  recordQuestionAcknowledgement,
} from "./questions.ts";

type Delivery = {
  questionId: string;
  answerId: string;
  attemptId: string;
  agentName: string;
  deliveredAt: string | null;
};

export type DeliverResult =
  | (Delivery & { status: "delivered"; repeated: boolean })
  | { status: "unknown-question"; questionId: string }
  | { status: "not-answered"; questionId: string; state: string }
  | { status: "already-acknowledged"; questionId: string; acknowledgedAt: string }
  | { status: "not-dispatched"; attemptId: string }
  | { status: "reconciliation-required"; questionId: string; operationState: string }
  | { status: "delivery-failed"; questionId: string; detail: string }
  | { status: "delivery-uncertain"; questionId: string; detail: string }
  | AttemptFailure
  | Shared;

type OpenOutcome = { status: "opened" } | { status: "delivery-held"; operationState: string };

type Prepared = {
  status: "prepared";
  question: QuestionRow;
  answer: AnswerRow;
  agentName: string;
  operation: OperationRow | null;
};

/**
 * Carries one recorded answer to the Operative that asked for it.
 * Recording an answer and delivering it are separate, so a decision is made once and the
 * delivery of it can be retried, reconciled, or refused without making a second decision.
 */
export async function deliverAnswer(request: {
  projectRoot: string;
  requestId: string;
  ownerToken: string;
  questionId: string;
}): Promise<DeliverResult> {
  const prepared = await prepare(request);
  if (prepared.status !== "prepared") {
    return prepared;
  }

  const { question, answer, agentName } = prepared;

  /** Reports a delivery this call must not repeat, from the state it is recorded in. */
  function held(operationState: string): DeliverResult {
    // An authorized external action is never repeated: a finished delivery reports what it did.
    return operationState === "succeeded"
      ? {
          status: "delivered",
          questionId: question.id,
          answerId: answer.id,
          attemptId: question.attemptId,
          agentName,
          deliveredAt: question.deliveredAt,
          repeated: true,
        }
      : { status: "reconciliation-required", questionId: question.id, operationState };
  }

  if (prepared.operation !== null && prepared.operation.state !== "failed") {
    return held(prepared.operation.state);
  }

  // Each pass carries its own identity, so a repeat is never mistaken for a replay of the call
  // this pass is about to make.
  const operationId = crypto.randomUUID();
  const { result: opened } = await mutate<OpenOutcome>(
    {
      projectRoot: request.projectRoot,
      requestId: `${request.requestId}#deliver.${operationId}.open`,
      ownerToken: request.ownerToken,
      now: new Date().toISOString(),
      operation: "question_deliver_open",
      input: { questionId: question.id, answerId: answer.id, operationId },
    },
    ({ tx, now }) => {
      // The intent is claimed inside the write, so two concurrent deliveries cannot both act.
      const row = readQuestion(tx, question.id);
      const live =
        row === null || row.deliveryOperationId === null
          ? null
          : readOperation(tx, row.deliveryOperationId);
      if (live !== null && live.state !== "failed") {
        return {
          commit: false,
          outcome: { status: "delivery-held" as const, operationState: live.state },
        };
      }

      openOperation(tx, {
        operationId,
        attemptId: question.attemptId,
        kind: ANSWER_DELIVERY,
        requestId: request.requestId,
        intent: { questionId: question.id, answerId: answer.id },
        now,
      });
      recordDeliveryIntent(tx, { questionId: question.id, operationId, now });
      return { commit: true, outcome: { status: "opened" as const } };
    },
  );
  if (opened.status === "delivery-held") {
    return held(opened.operationState);
  }
  if (opened.status !== "opened") {
    return opened;
  }

  const recordedAnswer = answerRecordOf(answer, question);
  const submitted = await OperativeDispatch.deliverAnswer({
    agentName,
    answer: {
      questionId: question.id,
      questionRevision: question.revision,
      attemptId: question.attemptId,
      authority: recordedAnswer.authority,
      exactText: recordedAnswer.exactText,
      interpretation: recordedAnswer.interpretation,
      source: recordedAnswer.source,
    },
  });

  const state =
    submitted.status === "succeeded"
      ? "succeeded"
      : submitted.status === "failed"
        ? "failed"
        : "uncertain";
  const detail =
    submitted.status === "succeeded"
      ? `Submitted the answer to ${agentName}.`
      : submitted.status === "failed"
        ? `${submitted.code}: ${submitted.detail}`
        : submitted.detail;

  const { result: settled } = await mutate<{ status: "settled"; now: string }>(
    {
      projectRoot: request.projectRoot,
      requestId: `${request.requestId}#deliver.${operationId}.settle`,
      ownerToken: request.ownerToken,
      now: new Date().toISOString(),
      operation: "question_deliver_result",
      input: { operationId, state, detail },
    },
    ({ tx, now }) => {
      settleOperation(tx, {
        operationId,
        attemptId: question.attemptId,
        state,
        detail,
        now,
      });
      if (state === "succeeded") {
        recordDelivered(tx, { questionId: question.id, now });
      }
      // The write states when it happened, so the moment of delivery is never read back.
      return { commit: true, outcome: { status: "settled" as const, now } };
    },
  );
  if (settled.status !== "settled") {
    return settled;
  }

  if (state === "failed") {
    return { status: "delivery-failed", questionId: question.id, detail };
  }
  if (state === "uncertain") {
    return { status: "delivery-uncertain", questionId: question.id, detail };
  }

  return {
    status: "delivered",
    questionId: question.id,
    answerId: answer.id,
    attemptId: question.attemptId,
    agentName,
    deliveredAt: settled.now,
    repeated: false,
  };
}

/** Reads everything one delivery needs, under the ownership the caller claims. */
async function prepare(request: {
  projectRoot: string;
  ownerToken: string;
  questionId: string;
}): Promise<Prepared | Exclude<DeliverResult, { status: "delivered" }>> {
  const found = await readState(request.projectRoot, (db) => findQuestion(db, request.questionId));
  if (found.status !== "found") {
    return found;
  }

  const question = found.question;
  if (question.acknowledgedAt !== null) {
    return {
      status: "already-acknowledged",
      questionId: question.id,
      acknowledgedAt: question.acknowledgedAt,
    };
  }

  const answerId = question.answerId;
  if (answerId === null) {
    return { status: "not-answered", questionId: question.id, state: question.state };
  }

  const read = await readContext(request.projectRoot, {
    attemptId: question.attemptId,
    ownerToken: request.ownerToken,
  });
  if (read.status !== "ok") {
    return read;
  }
  if (read.context.dispatch === null) {
    return { status: "not-dispatched", attemptId: question.attemptId };
  }

  // A revision drops the answer it was given, so the recorded one always answers what is asked.
  const answer = await readState(request.projectRoot, (db) => findAnswer(db, answerId));
  if (answer.status !== "found") {
    return { status: "not-answered", questionId: question.id, state: question.state };
  }

  const operation =
    question.deliveryOperationId === null
      ? null
      : (read.context.operations.find((one) => one.id === question.deliveryOperationId) ?? null);

  return {
    status: "prepared",
    question,
    answer: answer.answer,
    agentName: read.context.dispatch.agentName,
    operation,
  };
}

export type QuestionAcknowledgeResult =
  | {
      status: "acknowledged";
      questionId: string;
      assignmentId: string;
      attemptId: string;
      repeated: boolean;
    }
  | { status: "unknown-question"; questionId: string }
  | { status: "not-delivered"; questionId: string; state: string }
  | { status: "already-acknowledged"; questionId: string; acknowledgedAt: string }
  | { status: "reference-mismatch"; questionId: string; detail: string }
  | { status: "not-dispatched"; attemptId: string }
  | AttemptFailure
  | Shared;

/**
 * Records the Operative's own receipt of one answer, which releases the work that waited.
 * It also settles an unproven delivery, because an Operative cannot acknowledge an answer that
 * never reached it.
 */
export async function acknowledgeAnswer(request: {
  projectRoot: string;
  requestId: string;
  questionId: string;
  worktreePath: string;
}): Promise<QuestionAcknowledgeResult> {
  const found = await readState(request.projectRoot, (db) => findQuestion(db, request.questionId));
  if (found.status !== "found") {
    return found;
  }

  const question = found.question;
  if (question.acknowledgedAt !== null) {
    return {
      status: "already-acknowledged",
      questionId: question.id,
      acknowledgedAt: question.acknowledgedAt,
    };
  }
  if (question.deliveryOperationId === null) {
    return { status: "not-delivered", questionId: question.id, state: question.state };
  }

  const read = await readContext(request.projectRoot, {
    attemptId: question.attemptId,
    ownerToken: null,
  });
  if (read.status !== "ok") {
    return read;
  }

  const dispatch = read.context.dispatch;
  if (dispatch === null) {
    return { status: "not-dispatched", attemptId: question.attemptId };
  }
  if (dispatch.worktreePath !== request.worktreePath) {
    return {
      status: "reference-mismatch",
      questionId: question.id,
      detail: `This question belongs to the attempt in ${dispatch.worktreePath}.`,
    };
  }

  const delivery =
    read.context.operations.find((one) => one.id === question.deliveryOperationId) ?? null;
  const written = await record(
    {
      projectRoot: request.projectRoot,
      requestId: request.requestId,
      ownerToken: null,
      operation: "question_acknowledge",
      input: { questionId: question.id, worktreePath: request.worktreePath },
    },
    ({ tx, now }) => {
      recordQuestionAcknowledgement(tx, { questionId: question.id, now });
      if (delivery !== null && delivery.state !== "succeeded") {
        settleOperation(tx, {
          operationId: delivery.id,
          attemptId: question.attemptId,
          state: "succeeded",
          detail: "The Operative acknowledged the answer.",
          now,
        });
      }
      return { commit: true, outcome: { status: "recorded" as const } };
    },
  );
  if (written.status !== "recorded") {
    return written;
  }

  return {
    status: "acknowledged",
    questionId: question.id,
    assignmentId: question.assignmentId,
    attemptId: question.attemptId,
    repeated: written.repeated,
  };
}
