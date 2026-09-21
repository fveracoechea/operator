import { type AttemptFailure, readContext, type Shared } from "./dispatch-context.ts";
import { readOperation } from "./dispatch.ts";
import { type InvalidInput, parseInput } from "./input.ts";
import { mutate } from "./operations.ts";
import { questionInputSchema } from "./question-input.ts";
import {
  BLOCKING_STATES,
  blockingQuestionOf,
  insertQuestion,
  readQuestion,
  updateQuestion,
} from "./questions.ts";

type Raised = {
  status: "raised";
  questionId: string;
  assignmentId: string;
  attemptId: string;
  revision: number;
  escalationTriggers: string[];
  independentWork: string[];
};

export type RaiseResult =
  | (Raised & { repeated: boolean })
  | { status: "question-open"; questionId: string; attemptId: string; state: string }
  | { status: "not-dispatched"; attemptId: string }
  | InvalidInput
  | AttemptFailure
  | Shared;

/**
 * Records one blocked report from the Operative that holds the assignment.
 * The report carries no ownership token and no authority of its own, so it states what waits
 * and what continues, and nothing more.
 */
export async function raiseQuestion(request: {
  projectRoot: string;
  requestId: string;
  attemptId: string;
  questionId: string;
  input: unknown;
}): Promise<RaiseResult> {
  const parsed = parseInput(questionInputSchema, request.input);
  if (parsed.status !== "parsed") {
    return parsed;
  }

  const read = await readContext(request.projectRoot, {
    attemptId: request.attemptId,
    ownerToken: null,
  });
  if (read.status !== "ok") {
    return read;
  }
  if (read.context.dispatch === null) {
    return { status: "not-dispatched", attemptId: request.attemptId };
  }

  const input = parsed.value;
  const assignmentId = read.context.attempt.assignmentId;
  const { repeated, result } = await mutate<
    Raised | { status: "question-open"; questionId: string; attemptId: string; state: string }
  >(
    {
      projectRoot: request.projectRoot,
      requestId: request.requestId,
      ownerToken: null,
      now: new Date().toISOString(),
      operation: "question_raise",
      input: { attemptId: request.attemptId, question: input },
    },
    ({ tx, now }) => {
      // One Operative waits on one question, so a second report would hide the first.
      const held = blockingQuestionOf(tx, request.attemptId);
      if (held !== null) {
        return {
          commit: false,
          outcome: {
            status: "question-open" as const,
            questionId: held.id,
            attemptId: request.attemptId,
            state: held.state,
          },
        };
      }

      insertQuestion(tx, {
        questionId: request.questionId,
        assignmentId,
        attemptId: request.attemptId,
        input,
        now,
      });
      return {
        commit: true,
        outcome: {
          status: "raised" as const,
          questionId: request.questionId,
          assignmentId,
          attemptId: request.attemptId,
          revision: 1,
          escalationTriggers: input.escalationTriggers,
          independentWork: input.independentWork,
        },
      };
    },
  );

  return result.status === "raised" ? { ...result, repeated } : result;
}

type Revised = {
  status: "revised";
  questionId: string;
  revision: number;
  droppedAnswerId: string | null;
  escalationTriggers: string[];
};

type ReviseOutcome =
  | Revised
  | { status: "unknown-question"; questionId: string }
  | { status: "question-mismatch"; questionId: string; attemptId: string }
  | { status: "stale-question-revision"; questionId: string; recordedRevision: number }
  | { status: "question-closed"; questionId: string; state: string }
  | { status: "delivery-started"; questionId: string; state: string };

export type ReviseResult =
  | (Revised & { repeated: boolean })
  | Exclude<ReviseOutcome, Revised>
  | InvalidInput
  | AttemptFailure
  | Shared;

/**
 * Records a changed question from the Operative that raised it.
 * The revision moves, so an answer given to the earlier question stops applying and needs an
 * applicability check and an approval before it is used again.
 */
export async function reviseQuestion(request: {
  projectRoot: string;
  requestId: string;
  attemptId: string;
  questionId: string;
  revision: number;
  input: unknown;
}): Promise<ReviseResult> {
  const parsed = parseInput(questionInputSchema, request.input);
  if (parsed.status !== "parsed") {
    return parsed;
  }

  const read = await readContext(request.projectRoot, {
    attemptId: request.attemptId,
    ownerToken: null,
  });
  if (read.status !== "ok") {
    return read;
  }

  const input = parsed.value;
  const { repeated, result } = await mutate<ReviseOutcome>(
    {
      projectRoot: request.projectRoot,
      requestId: request.requestId,
      ownerToken: null,
      now: new Date().toISOString(),
      operation: "question_revise",
      input: { questionId: request.questionId, revision: request.revision, question: input },
    },
    ({ tx, now }) => {
      const row = readQuestion(tx, request.questionId);
      if (row === null) {
        return {
          commit: false,
          outcome: { status: "unknown-question" as const, questionId: request.questionId },
        };
      }
      if (row.attemptId !== request.attemptId) {
        return {
          commit: false,
          outcome: {
            status: "question-mismatch" as const,
            questionId: row.id,
            attemptId: row.attemptId,
          },
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
      // A question nobody waits on any more is history, so it is never asked again in place.
      if (!BLOCKING_STATES.some((state) => state === row.state)) {
        return {
          commit: false,
          outcome: { status: "question-closed" as const, questionId: row.id, state: row.state },
        };
      }
      // An answer already on its way is not revised behind the Operative that will read it.
      // A delivery that is proven not to have happened leaves the question free to change.
      const delivery =
        row.deliveryOperationId === null ? null : readOperation(tx, row.deliveryOperationId);
      if (delivery !== null && delivery.state !== "failed") {
        return {
          commit: false,
          outcome: { status: "delivery-started" as const, questionId: row.id, state: row.state },
        };
      }

      const revision = updateQuestion(tx, { row, input, now });
      return {
        commit: true,
        outcome: {
          status: "revised" as const,
          questionId: row.id,
          revision,
          droppedAnswerId: row.answerId,
          escalationTriggers: input.escalationTriggers,
        },
      };
    },
  );

  return result.status === "revised" ? { ...result, repeated } : result;
}
