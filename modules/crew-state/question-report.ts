import { readState, type StateFailure } from "./operations.ts";
import { type QuestionRecord, questionRecordOf, readQuestion } from "./questions.ts";

export type ShowQuestionResult =
  | { status: "reported"; question: QuestionRecord }
  | { status: "unknown-question"; questionId: string }
  | StateFailure;

/**
 * Reports one question with every answer it has held.
 * It is a read anyone may run, because recovery reads the routing before it changes anything.
 */
export async function showQuestion(request: {
  projectRoot: string;
  questionId: string;
}): Promise<ShowQuestionResult> {
  const read = await readState(request.projectRoot, (db) => {
    const row = readQuestion(db, request.questionId);
    return row === null
      ? { status: "unknown-question" as const, questionId: request.questionId }
      : { status: "reported" as const, question: questionRecordOf(db, row) };
  });

  return read;
}
