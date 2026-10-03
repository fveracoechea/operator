import type { externalOperations, questions } from "./schema.ts";

type QuestionRow = typeof questions.$inferSelect;
type OperationRow = typeof externalOperations.$inferSelect;

/**
 * The question machine (ADR 0023, ADR 0006). One `questions` row moves through these states.
 * An acknowledged answer resolves it, and the end of its attempt withdraws it.
 */
export type QuestionState = "open" | "answered" | "delivered" | "resolved" | "withdrawn";

/** The states in which a question still holds its Operative. */
export const BLOCKING_STATES = ["open", "answered", "delivered"] as const;

/** The events that move one question. A reapplied answer is an answer. */
export type QuestionEvent = "raise" | "revise" | "answer" | "escalate" | "deliver" | "acknowledge";

/**
 * What each event reads before it decides. The caller gathers these facts. An event on a
 * question that is not recorded is refused by the read that finds no row, before any guard.
 */
export type QuestionFacts = {
  /** The question the raising attempt still waits on. */
  raise: { held: QuestionRow | null; attemptId: string };
  revise: { row: QuestionRow; attemptId: string; revision: number; delivery: OperationRow | null };
  answer: { row: QuestionRow; revision: number };
  /** Whether the escalation drops the Operator decision the question holds. */
  escalate: {
    row: QuestionRow;
    revision: number;
    delivery: OperationRow | null;
    dropsDecision: boolean;
  };
  deliver: { row: QuestionRow };
  acknowledge: { row: QuestionRow };
};

type Mismatch = { status: "question-mismatch"; questionId: string; attemptId: string };
type Stale = { status: "stale-question-revision"; questionId: string; recordedRevision: number };
type Closed = { status: "question-closed"; questionId: string; state: string };
type DeliveryStarted = { status: "delivery-started"; questionId: string; state: string };
type Answered = { status: "already-answered"; questionId: string; answerId: string };
type Acknowledged = { status: "already-acknowledged"; questionId: string; acknowledgedAt: string };

/** The refusals of each event. */
export type QuestionRefusal = {
  raise: { status: "question-open"; questionId: string; attemptId: string; state: string };
  revise: Mismatch | Stale | Closed | DeliveryStarted;
  answer: Stale | Closed | Answered;
  escalate: Stale | Closed | DeliveryStarted;
  deliver: Acknowledged | { status: "not-answered"; questionId: string; state: string };
  acknowledge: Acknowledged | { status: "not-delivered"; questionId: string; state: string };
};

/** The state each event moves a question to. A null state leaves the state as it is. */
export type QuestionNext = {
  raise: "open";
  revise: "open";
  answer: "answered";
  escalate: "open" | null;
  deliver: "delivered";
  acknowledge: "resolved";
};

type Guard<F, R> = (facts: F) => R | null;
type RowFacts = { row: QuestionRow };

/** Only the attempt that raised a question revises it. */
const ownAttempt: Guard<RowFacts & { attemptId: string }, Mismatch> = ({ row, attemptId }) =>
  row.attemptId === attemptId
    ? null
    : { status: "question-mismatch", questionId: row.id, attemptId: row.attemptId };

/** The caller states the revision it inspected, so a change in between is never overwritten. */
const current: Guard<RowFacts & { revision: number }, Stale> = ({ row, revision }) =>
  row.revision === revision
    ? null
    : { status: "stale-question-revision", questionId: row.id, recordedRevision: row.revision };

/**
 * A question nobody waits on any more is history. It is never asked again in place, and an
 * answer would revive it onto an attempt that ended, where no Operative can acknowledge it.
 */
const blocking: Guard<RowFacts, Closed> = ({ row }) =>
  BLOCKING_STATES.some((state) => state === row.state)
    ? null
    : { status: "question-closed", questionId: row.id, state: row.state };

/**
 * An answer already on its way is not changed behind the Operative that will read it. A delivery
 * that is proven not to have happened reached nobody, so the question stays free to change.
 */
const undelivered: Guard<RowFacts & { delivery: OperationRow | null }, DeliveryStarted> = ({
  row,
  delivery,
}) =>
  delivery === null || delivery.state === "failed"
    ? null
    : { status: "delivery-started", questionId: row.id, state: row.state };

/** One question revision carries one decision, so a second answer to it is refused. */
const unanswered: Guard<RowFacts, Answered> = ({ row }) =>
  row.answerId === null
    ? null
    : { status: "already-answered", questionId: row.id, answerId: row.answerId };

/** An acknowledged answer is never delivered or acknowledged again. */
const unacknowledged: Guard<RowFacts, Acknowledged> = ({ row }) =>
  row.acknowledgedAt === null
    ? null
    : { status: "already-acknowledged", questionId: row.id, acknowledgedAt: row.acknowledgedAt };

type Entry<E extends QuestionEvent> = {
  guards: Array<Guard<QuestionFacts[E], QuestionRefusal[E]>>;
  next: (facts: QuestionFacts[E]) => QuestionNext[E];
};

/** The transition table of a question: the guards of each event in order, and the next state. */
const QUESTION_TABLE: { [E in QuestionEvent]: Entry<E> } = {
  // One Operative waits on one question, so a second report would hide the first.
  raise: {
    guards: [
      ({ held, attemptId }) =>
        held === null
          ? null
          : { status: "question-open", questionId: held.id, attemptId, state: held.state },
    ],
    next: () => "open",
  },
  revise: { guards: [ownAttempt, current, blocking, undelivered], next: () => "open" },
  answer: { guards: [current, blocking, unanswered], next: () => "answered" },
  // Only an Operator decision falls to an escalation, and the question is then open again.
  escalate: {
    guards: [current, blocking, undelivered],
    next: ({ dropsDecision }) => (dropsDecision ? "open" : null),
  },
  deliver: {
    guards: [
      unacknowledged,
      ({ row }) =>
        row.answerId === null
          ? { status: "not-answered", questionId: row.id, state: row.state }
          : null,
    ],
    next: () => "delivered",
  },
  acknowledge: {
    guards: [
      unacknowledged,
      ({ row }) =>
        row.deliveryOperationId === null
          ? { status: "not-delivered", questionId: row.id, state: row.state }
          : null,
    ],
    next: () => "resolved",
  },
};

export const Question = {
  /**
   * Decides one event on one question. It is pure: it reads only the facts the caller gathered,
   * and it returns the first refusal in the order of the table, or the next state.
   */
  decide<E extends QuestionEvent>(
    event: E,
    facts: QuestionFacts[E],
  ): { refused: QuestionRefusal[E] } | { next: QuestionNext[E] } {
    const entry: Entry<E> = QUESTION_TABLE[event];
    for (const guard of entry.guards) {
      const refused = guard(facts);
      if (refused !== null) {
        return { refused };
      }
    }
    return { next: entry.next(facts) };
  },
};
