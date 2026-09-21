import { OperativeDispatch } from "../operative-dispatch/main.ts";
import { type AttemptFailure, readContext, record, type Shared } from "./dispatch-context.ts";
import { ANSWER_DELIVERY, openOperation, type OperationRow, settleOperation } from "./dispatch.ts";
import { readState } from "./operations.ts";
import {
  type AnswerRow,
  answerRecordOf,
  readAnswer,
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
  | { status: "answer-stale"; questionId: string; answerId: string; recordedRevision: number }
  | { status: "already-acknowledged"; questionId: string; acknowledgedAt: string }
  | { status: "not-dispatched"; attemptId: string }
  | { status: "reconciliation-required"; questionId: string; operationState: string }
  | { status: "delivery-failed"; questionId: string; detail: string }
  | { status: "delivery-uncertain"; questionId: string; detail: string }
  | AttemptFailure
  | Shared;

type Prepared = {
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
  if ("status" in prepared) {
    return prepared;
  }

  const { question, answer, agentName, operation } = prepared;

  // An authorized external action is never repeated: a finished delivery reports what it did.
  if (operation !== null && operation.state === "succeeded") {
    return {
      status: "delivered",
      questionId: question.id,
      answerId: answer.id,
      attemptId: question.attemptId,
      agentName,
      deliveredAt: question.deliveredAt,
      repeated: true,
    };
  }
  if (operation !== null && operation.state !== "failed") {
    return {
      status: "reconciliation-required",
      questionId: question.id,
      operationState: operation.state,
    };
  }

  // Each pass carries its own identity, so a repeat is never mistaken for a replay of the call
  // this pass is about to make.
  const pass = crypto.randomUUID();
  const operationId = pass;
  const opened = await record(
    {
      projectRoot: request.projectRoot,
      requestId: `${request.requestId}#deliver.${pass}.open`,
      ownerToken: request.ownerToken,
      operation: "question_deliver_open",
      input: { questionId: question.id, answerId: answer.id, operationId },
    },
    ({ tx, now }) => {
      openOperation(tx, {
        operationId,
        attemptId: question.attemptId,
        kind: ANSWER_DELIVERY,
        requestId: request.requestId,
        intent: { questionId: question.id, answerId: answer.id },
        now,
      });
      recordDeliveryIntent(tx, { questionId: question.id, operationId, now });
      return { commit: true, outcome: { status: "recorded" as const } };
    },
  );
  if (opened.status !== "recorded") {
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

  const settled = await record(
    {
      projectRoot: request.projectRoot,
      requestId: `${request.requestId}#deliver.${pass}.settle`,
      ownerToken: request.ownerToken,
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
      return { commit: true, outcome: { status: "recorded" as const } };
    },
  );
  if (settled.status !== "recorded") {
    return settled;
  }

  if (state === "failed") {
    return { status: "delivery-failed", questionId: question.id, detail };
  }
  if (state === "uncertain") {
    return { status: "delivery-uncertain", questionId: question.id, detail };
  }

  const after = await readState(request.projectRoot, (db) => readQuestion(db, question.id));
  return {
    status: "delivered",
    questionId: question.id,
    answerId: answer.id,
    attemptId: question.attemptId,
    agentName,
    deliveredAt: after === null || "status" in after ? null : after.deliveredAt,
    repeated: false,
  };
}

/** Reads everything one delivery needs, under the ownership the caller claims. */
async function prepare(request: {
  projectRoot: string;
  ownerToken: string;
  questionId: string;
}): Promise<Prepared | Exclude<DeliverResult, { status: "delivered" }>> {
  const found = await readState(request.projectRoot, (db) => readQuestion(db, request.questionId));
  if (found === null) {
    return { status: "unknown-question", questionId: request.questionId };
  }
  if ("status" in found) {
    return found;
  }

  const question = found;
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

  const answer = await readState(request.projectRoot, (db) => readAnswer(db, answerId));
  if (answer === null || "status" in answer) {
    return { status: "not-answered", questionId: question.id, state: question.state };
  }
  // The recorded answer must still answer the question that is being asked right now.
  if (!answerRecordOf(answer, question).applicable) {
    return {
      status: "answer-stale",
      questionId: question.id,
      answerId: answer.id,
      recordedRevision: answer.questionRevision,
    };
  }

  const operation =
    question.deliveryOperationId === null
      ? null
      : (read.context.operations.find((one) => one.id === question.deliveryOperationId) ?? null);

  return { question, answer, agentName: read.context.dispatch.agentName, operation };
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
  const found = await readState(request.projectRoot, (db) => readQuestion(db, request.questionId));
  if (found === null) {
    return { status: "unknown-question", questionId: request.questionId };
  }
  if ("status" in found) {
    return found;
  }

  const question = found;
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
