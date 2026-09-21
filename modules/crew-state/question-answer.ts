import { approvalCovers, type Coverage, readApproval } from "./approvals.ts";
import { type InvalidInput, parseInput } from "./input.ts";
import { mutate, type RequestFailure, type StateFailure } from "./operations.ts";
import { answerInputSchema, escalationInputSchema } from "./question-input.ts";
import {
  BLOCKING_STATES,
  insertAnswer,
  insertReusedAnswer,
  readAnswer,
  readQuestion,
  recordEscalation,
  triggersOf,
} from "./questions.ts";

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
  | { status: "stale-question-revision"; questionId: string; recordedRevision: number }
  | { status: "already-answered"; questionId: string; answerId: string }
  | { status: "escalation-required"; questionId: string; escalationTriggers: string[] };

export type AnswerResult = (Recorded & { repeated: boolean }) | Refusal | InvalidInput | Shared;

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
  const { repeated, result } = await mutate<Recorded | Refusal>(
    {
      projectRoot: request.projectRoot,
      requestId: request.requestId,
      ownerToken: request.ownerToken,
      now: new Date().toISOString(),
      operation: "question_answer",
      input: { questionId: request.questionId, revision: request.revision, answer: input },
    },
    ({ tx, now }) => {
      const checked = checkQuestion(tx, request);
      if (checked.status !== "ok") {
        return { commit: false, outcome: checked.refusal };
      }

      const row = checked.row;
      const triggers = triggersOf(row);
      if (input.authority === "operator-decision" && triggers.length > 0) {
        return {
          commit: false,
          outcome: {
            status: "escalation-required" as const,
            questionId: row.id,
            escalationTriggers: triggers,
          },
        };
      }

      insertAnswer(tx, {
        answerId: request.answerId,
        question: row,
        input,
        reusedFromId: null,
        approvalId: null,
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
      const checked = checkQuestion(tx, request);
      if (checked.status !== "ok") {
        return { commit: false, outcome: checked.refusal };
      }

      const row = checked.row;
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

      // The applicability check: what the Operator could decide alone before may now be a
      // subject only a person may settle, and an older decision does not survive that change.
      const triggers = triggersOf(row);
      if (reused.authority === "operator-decision" && triggers.length > 0) {
        return {
          commit: false,
          outcome: {
            status: "escalation-required" as const,
            questionId: row.id,
            escalationTriggers: triggers,
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

type QuestionCheck =
  | { status: "ok"; row: NonNullable<ReturnType<typeof readQuestion>> }
  | { status: "refused"; refusal: Refusal };

/** The three preconditions both recording paths share: the question, its revision, and one answer. */
function checkQuestion(
  tx: Parameters<typeof readQuestion>[0],
  request: { questionId: string; revision: number },
): QuestionCheck {
  const row = readQuestion(tx, request.questionId);
  if (row === null) {
    return {
      status: "refused",
      refusal: { status: "unknown-question", questionId: request.questionId },
    };
  }
  if (row.revision !== request.revision) {
    return {
      status: "refused",
      refusal: {
        status: "stale-question-revision",
        questionId: row.id,
        recordedRevision: row.revision,
      },
    };
  }
  // One question revision carries one decision, so a second answer to it is refused.
  if (row.answerId !== null) {
    return {
      status: "refused",
      refusal: { status: "already-answered", questionId: row.id, answerId: row.answerId },
    };
  }

  return { status: "ok", row };
}

type Escalated = {
  status: "escalated";
  questionId: string;
  escalationTriggers: string[];
  droppedAnswerId: string | null;
};

export type EscalateResult =
  | (Escalated & { repeated: boolean })
  | { status: "unknown-question"; questionId: string }
  | { status: "stale-question-revision"; questionId: string; recordedRevision: number }
  | { status: "question-closed"; questionId: string; state: string }
  | { status: "delivery-started"; questionId: string; state: string }
  | InvalidInput
  | Shared;

type EscalateOutcome = Escalated | Exclude<EscalateResult, Escalated | InvalidInput | Shared>;

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
      const row = readQuestion(tx, request.questionId);
      if (row === null) {
        return {
          commit: false,
          outcome: { status: "unknown-question" as const, questionId: request.questionId },
        };
      }
      if (row.revision !== request.revision) {
        return {
          commit: false,
          outcome: {
            status: "stale-question-revision" as const,
            questionId: row.id,
            recordedRevision: row.revision,
          },
        };
      }
      if (!BLOCKING_STATES.some((state) => state === row.state)) {
        return {
          commit: false,
          outcome: { status: "question-closed" as const, questionId: row.id, state: row.state },
        };
      }
      // An answer already on its way cannot be withdrawn, so the escalation comes too late.
      if (row.deliveryOperationId !== null) {
        return {
          commit: false,
          outcome: { status: "delivery-started" as const, questionId: row.id, state: row.state },
        };
      }

      // Only an Operator decision falls to an escalation. A person's answer already stands.
      const recorded = row.answerId === null ? null : readAnswer(tx, row.answerId);
      const droppedAnswerId =
        recorded !== null && recorded.authority === "operator-decision" ? recorded.id : null;

      recordEscalation(tx, { row, input, droppedAnswerId, now });
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
