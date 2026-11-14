import { Err, Ok, type Result } from "unthrown";
import type { ResultContext } from "../../lib/cli-result.ts";

export type QuestionCommand = "ask" | "withdraw" | "escalate" | "answer";
export type QuestionState = "open" | "awaiting_person" | "answered" | "withdrawn" | "abandoned";
export type AnswerAuthority = "super-agent" | "person";
type Pane = { socket: string | null; paneId: string | null };
type Facts = {
  command: QuestionCommand;
  assignment: { key: string; state: string };
  launch: { id: string; state: string; paneId: string | null; herdrSocket: string | null } | null;
  /** The recorded question with the command's key, when one was asked. */
  question: { key: string; state: QuestionState } | null;
  /** The pane that runs the command, when Herdr supplies one. */
  caller: Pane;
};
type QuestionTransition = { insert: true; state: "open" } | { insert: false; state: QuestionState };
type Refusal = ResultContext & { reason: string; detail: string };

const unanswered: QuestionState[] = ["open", "awaiting_person"];
const ended = ["merged", "completed", "abandoned"];

function refuse(reason: string, detail: string, context: ResultContext) {
  return Err<Refusal>({
    reason,
    detail: `${detail} Nothing changed.`,
    next: { command: "operator next", why: "Read the current question action before retrying." },
    ...context,
  });
}

/** The worker's own pane cannot answer or escalate its own question. */
function selfDecision({ launch, caller }: Facts) {
  return (
    launch !== null &&
    launch.paneId !== null &&
    caller.paneId === launch.paneId &&
    caller.socket === launch.herdrSocket
  );
}

function recorded(facts: Facts, from: QuestionState[], to: QuestionState) {
  const { assignment, question } = facts;
  if (question === null)
    return refuse(
      "question_not_found",
      `Assignment ${assignment.key} has no question with this key.`,
      {
        next: {
          decider: "super-agent",
          question: "Which recorded question key should this command target?",
        },
        state: { question: null },
      },
    );
  if (!from.includes(question.state))
    return refuse(
      "question_not_open",
      `Question ${question.key} of ${assignment.key} is ${question.state}.`,
      { state: { question: question.state } },
    );
  return Ok<QuestionTransition>({ insert: false, state: to });
}

const rules: Record<QuestionCommand, (facts: Facts) => Result<QuestionTransition, Refusal>> = {
  ask(facts) {
    const { assignment, launch, question } = facts;
    if (ended.includes(assignment.state) || launch?.state !== "running")
      return refuse(
        "assignment_not_running",
        `Assignment ${assignment.key} has no running worker launch.`,
        { state: { assignment: assignment.state, launch: launch?.state ?? null } },
      );
    // A key names one question for the whole assignment, also after an answer or a withdrawal.
    if (question !== null)
      return refuse(
        "question_key_taken",
        `Assignment ${assignment.key} already asked question ${question.key}. Ask with a new key.`,
        {
          next: {
            decider: "super-agent",
            question: "Which new key should identify this question?",
          },
          state: { questionExists: true },
        },
      );
    return Ok({ insert: true, state: "open" });
  },
  withdraw: (facts) => recorded(facts, unanswered, "withdrawn"),
  escalate: (facts) => recorded(facts, ["open"], "awaiting_person"),
  answer: (facts) => recorded(facts, unanswered, "answered"),
};

/**
 * The worker asks and withdraws from its own pane. Only the supervising SuperAgent answers or
 * moves a question to the person, never from the worker's pane. An ended assignment's
 * unanswered questions are abandoned in the transaction that ends it.
 */
export function decideQuestion(facts: Facts): Result<QuestionTransition, Refusal> {
  if ((facts.command === "answer" || facts.command === "escalate") && selfDecision(facts))
    return refuse(
      "self_decision_refused",
      "A WorkerAgent cannot answer its own question. The supervising SuperAgent decides from its own pane.",
      {
        next: {
          decider: "super-agent",
          question: "What is your decision from your own supervising pane?",
        },
        state: { samePane: true, sameServer: true },
      },
    );
  return rules[facts.command](facts);
}

/**
 * What a worker's wait returns for the question's current state. A wait that started on an
 * open question also returns when the SuperAgent moves it to the person, so the worker knows
 * that the answer can take longer. Null means that the wait continues.
 */
export function decideQuestionWait(started: QuestionState, current: QuestionState) {
  if (current === "answered") return "question_answered" as const;
  if (current === "withdrawn") return "question_withdrawn" as const;
  if (current === "abandoned") return "question_abandoned" as const;
  if (current === "awaiting_person" && started === "open")
    return "question_awaiting_person" as const;
  return null;
}
