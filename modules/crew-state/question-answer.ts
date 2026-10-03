import { approvalCovers, type Coverage, readApproval } from "./approvals.ts";
import type { CrewReader } from "./database.ts";
import { readOperation } from "./dispatch.ts";
import { type InvalidInput, parseInput } from "./input.ts";
import { mutate, type RequestFailure, type StateFailure } from "./operations.ts";
import {
  answerInputSchema,
  escalationInputSchema,
  type EscalationTrigger,
  unclosedBy,
} from "./question-input.ts";
import {
  Question,
  type QuestionFacts,
  type QuestionNext,
  type QuestionRefusal,
} from "./question-machine.ts";
import {
  insertAnswer,
  insertReusedAnswer,
  readAnswer,
  readQuestion,
  type QuestionRow,
  recordEscalation,
  triggersOf,
} from "./questions.ts";
import {
  copyRefusal,
  prepareSource,
  storeSource,
  type PrepareOutcome,
  type QuoteOutcome,
  quoteSource,
  type RecordedSource,
} from "./requirement-source.ts";

type Shared = StateFailure | RequestFailure;

/** The action one approval must name before an earlier answer is used for a changed question. */
const REUSE_ACTION = "answer-reuse";

function reuseScope(questionId: string): string {
  return `question:${questionId}`;
}

type Recorded = {
  status: "answered";
  questionId: string;
  answerId: string;
  authority: string;
  questionRevision: number;
  reusedFromId: string | null;
  approvalId: string | null;
};

type Refusal =
  | { status: "unknown-question"; questionId: string }
  | QuestionRefusal["answer"]
  | {
      status: "escalation-required";
      questionId: string;
      escalationTriggers: EscalationTrigger[];
      authority: string;
    };

type QuoteRefusal = Exclude<QuoteOutcome, { status: "quoted" }>;

export type AnswerResult =
  | (Recorded & { repeated: boolean })
  | Refusal
  | QuoteRefusal
  | Exclude<PrepareOutcome, { status: "prepared" }>
  | InvalidInput
  | Shared;

/**
 * Records the authoritative answer to one question revision.
 * An Operator decision is refused for a question that names a subject only a person may settle,
 * so unattended work never invents visible behavior, scope, or a security permission.
 */
export async function answerQuestion(request: {
  projectRoot: string;
  requestId: string;
  ownerToken: string;
  questionId: string;
  revision: number;
  answerId: string;
  input: unknown;
}): Promise<AnswerResult> {
  const parsed = parseInput(answerInputSchema, request.input);
  if (parsed.status !== "parsed") {
    return parsed;
  }

  const input = parsed.value;
  // A quote that the copy refuses stores nothing. A copy that holds the quote is stored before
  // the transaction, as a submission stores its artifacts. It is named by its content, so a
  // repeated request writes the same bytes again.
  const requirement =
    input.authority === "requirement"
      ? {
          exactText: input.exactText,
          prepared: await prepareSource({ projectRoot: request.projectRoot, source: input.source }),
        }
      : null;
  if (requirement !== null) {
    if (requirement.prepared.status !== "prepared") {
      return requirement.prepared;
    }
    const refused = copyRefusal({
      source: requirement.prepared.source,
      exactText: requirement.exactText,
    });
    if (refused !== null) {
      return refused;
    }
    await storeSource({ projectRoot: request.projectRoot, source: requirement.prepared.source });
  }

  const { repeated, result } = await mutate<Recorded | Refusal | QuoteRefusal>(
    {
      projectRoot: request.projectRoot,
      requestId: request.requestId,
      ownerToken: request.ownerToken,
      now: new Date().toISOString(),
      operation: "question_answer",
      input: { questionId: request.questionId, revision: request.revision, answer: input },
    },
    ({ tx, now }) => {
      const decided = decideOn(tx, request.questionId, "answer", (row) => ({
        row,
        revision: request.revision,
      }));
      if (decided.status !== "ok") {
        return { commit: false, outcome: decided.refusal };
      }

      const { row, next } = decided;

      const unclosed = unclosedBy(input.authority, triggersOf(row));
      if (unclosed.length > 0) {
        return {
          commit: false,
          outcome: {
            status: "escalation-required" as const,
            questionId: row.id,
            escalationTriggers: unclosed,
            authority: input.authority,
          },
        };
      }

      let source: RecordedSource | null = null;
      if (requirement !== null && requirement.prepared.status === "prepared") {
        const quoted = quoteSource(tx, {
          source: requirement.prepared.source,
          exactText: requirement.exactText,
        });
        if (quoted.status !== "quoted") {
          return { commit: false, outcome: quoted };
        }
        source = quoted.source;
      }

      insertAnswer(tx, {
        answerId: request.answerId,
        question: row,
        input,
        source,
        reusedFromId: null,
        approvalId: null,
        state: next,
        now,
      });
      return {
        commit: true,
        outcome: {
          status: "answered" as const,
          questionId: row.id,
          answerId: request.answerId,
          authority: input.authority,
          questionRevision: row.revision,
          reusedFromId: null,
          approvalId: null,
        },
      };
    },
  );

  return result.status === "answered" ? { ...result, repeated } : result;
}

type ReuseRefusal =
  | Refusal
  | { status: "unknown-answer"; answerId: string }
  | { status: "answer-not-earlier"; answerId: string; questionRevision: number }
  | { status: "unknown-approval"; approvalId: string }
  | { status: "approval-revoked"; approvalId: string }
  | { status: "approval-mismatch"; approvalId: string; field: string };

export type ReuseResult = (Recorded & { repeated: boolean }) | ReuseRefusal | Shared;

/**
 * Uses an answer recorded for an earlier question revision again.
 * It runs only when the answer still fits what the question now asks and when an approval names
 * that exact answer, this question, and the revision it is being reused for.
 */
export async function reapplyAnswer(request: {
  projectRoot: string;
  requestId: string;
  ownerToken: string;
  questionId: string;
  revision: number;
  answerId: string;
  reuseAnswerId: string;
  approvalId: string;
}): Promise<ReuseResult> {
  const { repeated, result } = await mutate<Recorded | ReuseRefusal>(
    {
      projectRoot: request.projectRoot,
      requestId: request.requestId,
      ownerToken: request.ownerToken,
      now: new Date().toISOString(),
      operation: "question_reapply",
      input: {
        questionId: request.questionId,
        revision: request.revision,
        reuseAnswerId: request.reuseAnswerId,
        approvalId: request.approvalId,
      },
    },
    ({ tx, now }) => {
      const decided = decideOn(tx, request.questionId, "answer", (row) => ({
        row,
        revision: request.revision,
      }));
      if (decided.status !== "ok") {
        return { commit: false, outcome: decided.refusal };
      }

      const { row, next } = decided;

      const reused = readAnswer(tx, request.reuseAnswerId);
      if (reused === null || reused.questionId !== row.id) {
        return {
          commit: false,
          outcome: { status: "unknown-answer" as const, answerId: request.reuseAnswerId },
        };
      }
      if (reused.questionRevision >= row.revision) {
        return {
          commit: false,
          outcome: {
            status: "answer-not-earlier" as const,
            answerId: reused.id,
            questionRevision: reused.questionRevision,
          },
        };
      }

      // The applicability check: what one authority could close before may now be a subject it
      // cannot, and an answer given under the old reading does not survive that change.
      const unclosed = unclosedBy(reused.authority, triggersOf(row));
      if (unclosed.length > 0) {
        return {
          commit: false,
          outcome: {
            status: "escalation-required" as const,
            questionId: row.id,
            escalationTriggers: unclosed,
            authority: reused.authority,
          },
        };
      }

      const approval = readApproval(tx, request.approvalId);
      if (approval === null) {
        return {
          commit: false,
          outcome: { status: "unknown-approval" as const, approvalId: request.approvalId },
        };
      }

      const coverage: Coverage = approvalCovers(approval, {
        action: REUSE_ACTION,
        targets: [reused.id],
        scope: reuseScope(row.id),
        requestRevision: String(row.revision),
      });
      if (coverage.status === "revoked") {
        return {
          commit: false,
          outcome: { status: "approval-revoked" as const, approvalId: approval.id },
        };
      }
      if (coverage.status === "mismatch") {
        return {
          commit: false,
          outcome: {
            status: "approval-mismatch" as const,
            approvalId: approval.id,
            field: coverage.field,
          },
        };
      }

      insertReusedAnswer(tx, {
        answerId: request.answerId,
        question: row,
        reused,
        approvalId: approval.id,
        state: next,
        now,
      });
      return {
        commit: true,
        outcome: {
          status: "answered" as const,
          questionId: row.id,
          answerId: request.answerId,
          authority: reused.authority,
          questionRevision: row.revision,
          reusedFromId: reused.id,
          approvalId: approval.id,
        },
      };
    },
  );

  return result.status === "answered" ? { ...result, repeated } : result;
}

type UnknownQuestion = { status: "unknown-question"; questionId: string };

/**
 * Reads the question one answer or escalation names, and decides the event on it. A question
 * that is not recorded is refused before the guards of the question machine run.
 */
function decideOn<E extends "answer" | "escalate">(
  tx: CrewReader,
  questionId: string,
  event: E,
  factsOf: (row: QuestionRow) => QuestionFacts[E],
):
  | { status: "ok"; row: QuestionRow; next: QuestionNext[E] }
  | { status: "refused"; refusal: UnknownQuestion | QuestionRefusal[E] } {
  const row = readQuestion(tx, questionId);
  if (row === null) {
    return { status: "refused", refusal: { status: "unknown-question", questionId } };
  }
  const decision = Question.decide(event, factsOf(row));
  return "refused" in decision
    ? { status: "refused", refusal: decision.refused }
    : { status: "ok", row, next: decision.next };
}

type Escalated = {
  status: "escalated";
  questionId: string;
  escalationTriggers: EscalationTrigger[];
  droppedAnswerId: string | null;
};

type EscalateRefusal = UnknownQuestion | QuestionRefusal["escalate"];

export type EscalateResult =
  | (Escalated & { repeated: boolean })
  | EscalateRefusal
  | InvalidInput
  | Shared;

type EscalateOutcome = Escalated | EscalateRefusal;

/**
 * Records the Operator's own finding that one question is outside delegated authority.
 * The Operative declares what it sees when it raises the question; this records what the
 * Operator sees, so the refusal of an Operator decision outlives the session that found it.
 */
export async function escalateQuestion(request: {
  projectRoot: string;
  requestId: string;
  ownerToken: string;
  questionId: string;
  revision: number;
  input: unknown;
}): Promise<EscalateResult> {
  const parsed = parseInput(escalationInputSchema, request.input);
  if (parsed.status !== "parsed") {
    return parsed;
  }

  const input = parsed.value;
  const { repeated, result } = await mutate<EscalateOutcome>(
    {
      projectRoot: request.projectRoot,
      requestId: request.requestId,
      ownerToken: request.ownerToken,
      now: new Date().toISOString(),
      operation: "question_escalate",
      input: { questionId: request.questionId, revision: request.revision, escalation: input },
    },
    ({ tx, now }) => {
      const decided = decideOn(tx, request.questionId, "escalate", (row) => {
        // Only an Operator decision falls to an escalation. A person's answer already stands.
        const recorded = row.answerId === null ? null : readAnswer(tx, row.answerId);
        return {
          row,
          revision: request.revision,
          delivery:
            row.deliveryOperationId === null ? null : readOperation(tx, row.deliveryOperationId),
          dropsDecision: recorded !== null && recorded.authority === "operator-decision",
        };
      });
      if (decided.status !== "ok") {
        return { commit: false, outcome: decided.refusal };
      }

      const { row, next } = decided;
      const droppedAnswerId = next === null ? null : row.answerId;
      recordEscalation(tx, { row, input, state: next, now });
      return {
        commit: true,
        outcome: {
          status: "escalated" as const,
          questionId: row.id,
          escalationTriggers: triggersOf({
            ...row,
            operatorEscalation: JSON.stringify(input),
          }),
          droppedAnswerId,
        },
      };
    },
  );

  return result.status === "escalated" ? { ...result, repeated } : result;
}
