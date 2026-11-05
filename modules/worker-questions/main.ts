import { Err, Ok, fromPromise } from "unthrown";
import { z } from "zod";
import { DeviceState } from "../device-state/main.ts";
import { answerKey, answerSchema, questionSchema } from "./content.ts";
import { acknowledge, ring, steering } from "./steering.ts";
import { qualify } from "./failures.ts";
import {
  caller,
  now,
  stop,
  superAgentTarget,
  workerPane,
  type Failure,
  type Paths,
  type Selector,
  type Target,
} from "./targets.ts";
import {
  decideQuestion,
  decideQuestionWait,
  type AnswerAuthority,
  type QuestionCommand,
  type QuestionState,
} from "./question-machine.ts";

type Facts = Extract<ReturnType<typeof DeviceState.readQuestion>, { tag: "Ok" }>["value"];
type Row = NonNullable<Facts["question"]>;

// The wait reads only device state, so it can look often without an external limit.
const pollMs = 1000;
const stateSchema = z.enum(["open", "awaiting_person", "answered", "withdrawn", "abandoned"]);

function decide(facts: Facts, command: QuestionCommand) {
  return decideQuestion({
    command,
    assignment: facts.assignment,
    launch: facts.launch,
    question:
      facts.question === null
        ? null
        : { key: facts.question.key, state: stateSchema.parse(facts.question.state) },
    caller: caller(),
  });
}

/** The question as the SuperAgent and the worker read it. */
function summary(facts: Facts, row: Row) {
  return {
    sourceId: facts.source.id,
    assignment: facts.assignment.key,
    key: row.key,
    state: row.state,
    question: row.question,
    askedAt: row.askedAt,
    answer: row.answer,
    by: row.answeredBy,
    answeredAt: row.answeredAt,
  };
}

/** Apply one transition, then read the recorded question back. */
function change(
  paths: Paths,
  target: Target,
  key: string,
  command: QuestionCommand,
  fields: (facts: Facts) => Partial<Row>,
) {
  return DeviceState.changeQuestion(paths, target, key, (facts) =>
    decide(facts, command).map(({ state }) => {
      const update: Partial<Row> = { ...fields(facts), state };
      // A withdrawal ends the question. An answer keeps its own time.
      if (state === "withdrawn") update.endedAt = now();
      return { update };
    }),
  ).flatMap(() => DeviceState.readQuestion(paths, target, key));
}

function recordedSummary(facts: Facts) {
  // Stryker disable next-line ConditionalExpression: equivalent: a successful change always leaves its question recorded
  if (facts.question === null)
    return Err<Failure>({ reason: "question_defect", detail: "The question is not recorded." });
  return Ok(summary(facts, facts.question));
}

function ask(input: { paths: Paths; file: string }) {
  return fromPromise(
    async () => {
      const target = workerPane();
      if (target.tag !== "Ok") return stop(target);
      const asked = questionSchema.parse(JSON.parse(await Bun.file(input.file).text()));
      return DeviceState.changeQuestion(input.paths, target.value, asked.key, (facts) =>
        decide(facts, "ask").map(({ state }) => ({
          insert: {
            sourceId: facts.source.id,
            assignment: facts.assignment.key,
            key: asked.key,
            // Stryker disable next-line OptionalChaining, StringLiteral: equivalent: asking needs a running launch, so the launch is never null here
            launchId: facts.launch?.id ?? "",
            question: asked.question,
            askedAt: now(),
            state,
            answer: null,
            answeredBy: null,
            answeredAt: null,
            endedAt: null,
          },
        })),
      )
        .flatMap(() => DeviceState.readQuestion(input.paths, target.value, asked.key))
        .flatMap(recordedSummary)
        .map((data) => ({ reason: "question_asked", data }));
    },
    (cause, defect) => (cause instanceof Error ? qualify(cause, defect) : defect(cause)),
  ).flatMap((result) => result);
}

function withdraw(input: { paths: Paths; key: string }) {
  return workerPane()
    .flatMap((target) => change(input.paths, target, input.key, "withdraw", () => ({})))
    .flatMap(recordedSummary)
    .map((data) => ({ reason: "question_withdrawn", data }));
}

function escalate(input: Selector) {
  return superAgentTarget(input).flatMap((target) =>
    change(input.paths, target, input.key, "escalate", () => ({}))
      .flatMap(recordedSummary)
      .map((data) => ({ reason: "question_escalated", data })),
  );
}

function answer(input: Selector & { by: AnswerAuthority; file: string }) {
  return fromPromise(
    async () => {
      const target = await superAgentTarget(input);
      if (target.tag !== "Ok") return stop(target);
      const text = answerSchema.parse(await Bun.file(input.file).text());
      const key = answerKey(input.key);
      // The answer reaches the worker as a steering message, recorded with the answer itself.
      const changed = DeviceState.changeQuestion(input.paths, target.value, input.key, (facts) =>
        decide(facts, "answer").map(({ state }) => {
          const answeredAt = now();
          return {
            update: { answer: text, answeredBy: input.by, answeredAt, state },
            message: {
              sourceId: facts.source.id,
              assignment: facts.assignment.key,
              key,
              // Stryker disable next-line OptionalChaining, StringLiteral: equivalent: an unanswered question belongs to a running launch, so the launch is never null here
              launchId: facts.launch?.id ?? "",
              message: text,
              questionKey: input.key,
              sentAt: answeredAt,
              state: "pending",
              rungAt: null,
              doorbellFailure: null,
              acknowledgedAt: null,
              reply: null,
              endedAt: null,
            },
          };
        }),
      );
      if (changed.tag !== "Ok") return stop(changed);
      // Stryker disable next-line OptionalChaining, StringLiteral: equivalent: an unanswered question belongs to a running launch, so the launch is never null here
      const worker = changed.value.facts.launch?.name ?? "";
      const rung = await ring(input.paths, target.value, key, worker);
      if (rung.tag !== "Ok") return stop(rung);
      return DeviceState.readQuestion(input.paths, target.value, input.key)
        .flatMap(recordedSummary)
        .map((data) => ({
          reason: "question_answered",
          data: { ...data, message: key, doorbellFailure: rung.value.doorbellFailure },
        }));
    },
    (cause, defect) => (cause instanceof Error ? qualify(cause, defect) : defect(cause)),
  ).flatMap((result) => result);
}

function read(paths: Paths, target: Target, key: string) {
  return DeviceState.readQuestion(paths, target, key).flatMap((facts) =>
    facts.question === null
      ? Err<Failure>({
          reason: "question_not_found",
          detail: `Assignment ${facts.assignment.key} has no question ${key}. Nothing changed.`,
        })
      : Ok({ facts, row: facts.question, state: stateSchema.parse(facts.question.state) }),
  );
}

async function poll(
  input: { paths: Paths; target: Target; key: string },
  started: QuestionState,
  deadline: number,
) {
  for (;;) {
    const current = read(input.paths, input.target, input.key);
    if (current.tag !== "Ok") return stop(current);
    const { facts, row, state } = current.value;
    const reason = decideQuestionWait(started, state);
    if (reason === "question_answered") {
      // Reading the answer acknowledges the steering message that delivered it.
      const read = acknowledge(input.paths, input.target, answerKey(input.key), null);
      if (read.tag === "Defect" || (read.tag === "Err" && read.error.reason !== "message_not_open"))
        return stop(read);
    }
    if (reason !== null) return Ok({ reason, data: summary(facts, row) });
    // Stryker disable next-line EqualityOperator: no rule: Operator promises no result for a read that ends in the same millisecond as the deadline
    if (Date.now() >= deadline)
      return Ok({ reason: "question_wait_timed_out", data: summary(facts, row) });
    await Bun.sleep(Math.min(pollMs, deadline - Date.now()));
  }
}

/** The worker's blocking read of its own question. It records only the read of an answer. */
function wait(input: { paths: Paths; key: string; timeoutSeconds: number }) {
  return fromPromise(
    async () => {
      const target = workerPane();
      if (target.tag !== "Ok") return stop(target);
      const first = read(input.paths, target.value, input.key);
      if (first.tag !== "Ok") return stop(first);
      return poll(
        { paths: input.paths, target: target.value, key: input.key },
        first.value.state,
        Date.now() + input.timeoutSeconds * 1000,
      );
    },
    (cause, defect) => (cause instanceof Error ? qualify(cause, defect) : defect(cause)),
  ).flatMap((result) => result);
}

/**
 * Recorded worker questions and steering messages. The worker asks, waits, withdraws, reads, and
 * acknowledges from its own pane. The supervising SuperAgent answers with the authority of the
 * answer, moves a question to the person, and sends, rings, and closes steering messages. An
 * answer reaches the worker as a steering message, so one doorbell serves both.
 */
export const WorkerQuestions = {
  ask(input: { paths: Paths; file: string }) {
    return ask(input);
  },
  wait(input: { paths: Paths; key: string; timeoutSeconds: number }) {
    return wait(input);
  },
  withdraw(input: { paths: Paths; key: string }) {
    return withdraw(input);
  },
  escalate(input: Selector) {
    return escalate(input);
  },
  answer(input: Selector & { by: AnswerAuthority; file: string }) {
    return answer(input);
  },
  /** Record a steering message for the running worker and ring its doorbell. */
  send(input: Omit<Selector, "key"> & { file: string }) {
    return steering.send(input);
  },
  /** Ring the doorbell of a pending message again. */
  ring(input: Selector) {
    return steering.ring(input);
  },
  /** End a message, after its reply or instead of a pending acknowledgement. */
  close(input: Selector) {
    return steering.close(input);
  },
  read(input: { paths: Paths; key: string }) {
    return steering.read(input);
  },
  /** The worker's acknowledgement, with a reply when a file is given. */
  acknowledge(input: { paths: Paths; key: string; file: string | null }) {
    return steering.acknowledge(input);
  },
};
