import { and, eq, inArray } from "drizzle-orm";
import { ContentIdentity } from "../content-identity/main.ts";
import type { CrewReader, CrewWriter } from "./database.ts";
import type {
  AnswerInput,
  AnswerInterpretation,
  EscalationInput,
  QuestionInput,
} from "./question-input.ts";
import { answers, questions } from "./schema.ts";

export type QuestionRow = typeof questions.$inferSelect;
export type AnswerRow = typeof answers.$inferSelect;

export type AnswerRecord = {
  answerId: string;
  questionRevision: number;
  authority: string;
  exactText: string | null;
  interpretation: AnswerInterpretation;
  source: { id: string; revision: string } | null;
  reusedFromId: string | null;
  approvalId: string | null;
  recordedAt: string;
  applicable: boolean;
};

export type QuestionRecord = {
  questionId: string;
  assignmentId: string;
  attemptId: string;
  revision: number;
  state: string;
  targetIdentity: string;
  escalationTriggers: string[];
  operatorEscalation: EscalationInput | null;
  report: QuestionInput;
  answer: AnswerRecord | null;
  answers: AnswerRecord[];
  deliveredAt: string | null;
  acknowledgedAt: string | null;
  raisedAt: string;
};

/**
 * The target of one question: the words asked and the scope that waits on the reply.
 * An answer is recorded against this identity, so a changed target makes it inapplicable.
 */
export function targetIdentityOf(input: QuestionInput): string {
  return ContentIdentity.of({
    question: input.question,
    affectedScope: input.affectedScope,
    escalationTriggers: input.escalationTriggers,
  });
}

export function questionReportOf(row: QuestionRow): QuestionInput {
  return JSON.parse(row.report);
}

export function operatorEscalationOf(row: QuestionRow): EscalationInput | null {
  return row.operatorEscalation === null ? null : JSON.parse(row.operatorEscalation);
}

/**
 * The subjects this question names that only a person may settle.
 * The Operative declares what it sees and the Operator records what it sees, so the answer is
 * everything either of them found, with neither record rewriting the other.
 */
export function triggersOf(row: QuestionRow): string[] {
  const declared = questionReportOf(row).escalationTriggers;
  const found = operatorEscalationOf(row)?.escalationTriggers ?? [];
  return [...new Set([...declared, ...found])].toSorted();
}

export function answerRecordOf(row: AnswerRow, question: QuestionRow): AnswerRecord {
  return {
    answerId: row.id,
    questionRevision: row.questionRevision,
    authority: row.authority,
    exactText: row.exactText,
    interpretation: JSON.parse(row.interpretation),
    source:
      row.sourceId === null || row.sourceRevision === null
        ? null
        : { id: row.sourceId, revision: row.sourceRevision },
    reusedFromId: row.reusedFromId,
    approvalId: row.approvalId,
    recordedAt: row.recordedAt,
    // An answer applies while the question it was given to still asks the same thing.
    applicable:
      row.questionRevision === question.revision && row.targetIdentity === question.targetIdentity,
  };
}

export function readQuestion(db: CrewReader, questionId: string): QuestionRow | null {
  return db.select().from(questions).where(eq(questions.id, questionId)).all()[0] ?? null;
}

export function readAnswer(db: CrewReader, answerId: string): AnswerRow | null {
  return db.select().from(answers).where(eq(answers.id, answerId)).all()[0] ?? null;
}

export function answersOf(db: CrewReader, questionId: string): AnswerRow[] {
  return db.select().from(answers).where(eq(answers.questionId, questionId)).all();
}

/**
 * The states in which a question still holds its Operative.
 * An acknowledged answer resolves it, and the end of an attempt withdraws it.
 */
export const BLOCKING_STATES = ["open", "answered", "delivered"] as const;

/** Every question that still holds its Operative. */
export function blockingQuestions(db: CrewReader): QuestionRow[] {
  return db
    .select()
    .from(questions)
    .where(inArray(questions.state, [...BLOCKING_STATES]))
    .all();
}

export function blockingQuestionOf(db: CrewReader, attemptId: string): QuestionRow | null {
  return (
    db
      .select()
      .from(questions)
      .where(
        and(eq(questions.attemptId, attemptId), inArray(questions.state, [...BLOCKING_STATES])),
      )
      .all()[0] ?? null
  );
}

/**
 * Withdraws the questions of an attempt that has ended.
 * A replacement starts its own attempt, so a question the former writer raised holds nothing.
 */
export function withdrawQuestions(
  db: CrewWriter,
  request: { attemptId: string; now: string },
): void {
  db.update(questions)
    .set({ state: "withdrawn", updatedAt: request.now })
    .where(
      and(
        eq(questions.attemptId, request.attemptId),
        inArray(questions.state, [...BLOCKING_STATES]),
      ),
    )
    .run();
}

/** The question one recorded delivery carries the answer of. */
export function questionByDelivery(db: CrewReader, operationId: string): QuestionRow | null {
  return (
    db.select().from(questions).where(eq(questions.deliveryOperationId, operationId)).all()[0] ??
    null
  );
}

export function questionRecordOf(db: CrewReader, row: QuestionRow): QuestionRecord {
  const recorded = answersOf(db, row.id).map((one) => answerRecordOf(one, row));
  return {
    questionId: row.id,
    assignmentId: row.assignmentId,
    attemptId: row.attemptId,
    revision: row.revision,
    state: row.state,
    targetIdentity: row.targetIdentity,
    escalationTriggers: triggersOf(row),
    operatorEscalation: operatorEscalationOf(row),
    report: questionReportOf(row),
    answer: recorded.find((one) => one.answerId === row.answerId) ?? null,
    answers: recorded,
    deliveredAt: row.deliveredAt,
    acknowledgedAt: row.acknowledgedAt,
    raisedAt: row.raisedAt,
  };
}

export function insertQuestion(
  db: CrewWriter,
  request: {
    questionId: string;
    assignmentId: string;
    attemptId: string;
    input: QuestionInput;
    now: string;
  },
): void {
  db.insert(questions)
    .values({
      id: request.questionId,
      assignmentId: request.assignmentId,
      attemptId: request.attemptId,
      revision: 1,
      state: "open",
      report: JSON.stringify(request.input),
      targetIdentity: targetIdentityOf(request.input),
      operatorEscalation: null,
      answerId: null,
      deliveryOperationId: null,
      deliveredAt: null,
      acknowledgedAt: null,
      raisedAt: request.now,
      updatedAt: request.now,
    })
    .run();
}

/**
 * Records a changed question. The revision moves and the current answer is dropped, so an
 * answer given to the earlier question is never delivered as the answer to this one.
 */
export function updateQuestion(
  db: CrewWriter,
  request: { row: QuestionRow; input: QuestionInput; now: string },
): number {
  const revision = request.row.revision + 1;
  db.update(questions)
    .set({
      revision,
      state: "open",
      report: JSON.stringify(request.input),
      targetIdentity: targetIdentityOf(request.input),
      answerId: null,
      deliveryOperationId: null,
      updatedAt: request.now,
    })
    .where(eq(questions.id, request.row.id))
    .run();

  return revision;
}

/**
 * Records the Operator's own escalation of one question.
 * An Operator decision recorded before it is dropped, because that authority no longer reaches
 * this question. A human answer or a requirement stands, because a person already spoke.
 */
export function recordEscalation(
  db: CrewWriter,
  request: {
    row: QuestionRow;
    input: EscalationInput;
    droppedAnswerId: string | null;
    now: string;
  },
): void {
  db.update(questions)
    .set({
      operatorEscalation: JSON.stringify(request.input),
      ...(request.droppedAnswerId === null ? {} : { answerId: null, state: "open" }),
      updatedAt: request.now,
    })
    .where(eq(questions.id, request.row.id))
    .run();
}

export function insertAnswer(
  db: CrewWriter,
  request: {
    answerId: string;
    question: QuestionRow;
    input: AnswerInput;
    reusedFromId: string | null;
    approvalId: string | null;
    now: string;
  },
): void {
  const source = request.input.authority === "requirement" ? request.input.source : null;
  db.insert(answers)
    .values({
      id: request.answerId,
      questionId: request.question.id,
      questionRevision: request.question.revision,
      targetIdentity: request.question.targetIdentity,
      authority: request.input.authority,
      exactText: request.input.authority === "operator-decision" ? null : request.input.exactText,
      interpretation: JSON.stringify(request.input.interpretation),
      sourceId: source?.id ?? null,
      sourceRevision: source?.revision ?? null,
      reusedFromId: request.reusedFromId,
      approvalId: request.approvalId,
      recordedAt: request.now,
    })
    .run();

  db.update(questions)
    .set({ answerId: request.answerId, state: "answered", updatedAt: request.now })
    .where(eq(questions.id, request.question.id))
    .run();
}

/**
 * Records an earlier answer again, against the question revision that now asks for it.
 * The reused row keeps the exact words and the reading of the answer it copies, and names both
 * that answer and the approval that permitted the reuse.
 */
export function insertReusedAnswer(
  db: CrewWriter,
  request: {
    answerId: string;
    question: QuestionRow;
    reused: AnswerRow;
    approvalId: string;
    now: string;
  },
): void {
  db.insert(answers)
    .values({
      ...request.reused,
      id: request.answerId,
      questionRevision: request.question.revision,
      targetIdentity: request.question.targetIdentity,
      reusedFromId: request.reused.id,
      approvalId: request.approvalId,
      recordedAt: request.now,
    })
    .run();

  db.update(questions)
    .set({ answerId: request.answerId, state: "answered", updatedAt: request.now })
    .where(eq(questions.id, request.question.id))
    .run();
}

export function recordDeliveryIntent(
  db: CrewWriter,
  request: { questionId: string; operationId: string; now: string },
): void {
  db.update(questions)
    .set({ deliveryOperationId: request.operationId, updatedAt: request.now })
    .where(eq(questions.id, request.questionId))
    .run();
}

export function recordDelivered(
  db: CrewWriter,
  request: { questionId: string; now: string },
): void {
  db.update(questions)
    .set({ state: "delivered", deliveredAt: request.now, updatedAt: request.now })
    .where(eq(questions.id, request.questionId))
    .run();
}

/** The Operative's own receipt. It resolves the question and releases the work that waited. */
export function recordQuestionAcknowledgement(
  db: CrewWriter,
  request: { questionId: string; now: string },
): void {
  db.update(questions)
    .set({ state: "resolved", acknowledgedAt: request.now, updatedAt: request.now })
    .where(eq(questions.id, request.questionId))
    .run();
}
