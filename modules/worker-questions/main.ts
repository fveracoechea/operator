import { Err, Ok, fromPromise, type Result } from "unthrown";
import { z } from "zod";
import { DeviceState } from "../device-state/main.ts";
import { Environment } from "../environment/main.ts";
import type { OperatorHome } from "../operator-home/main.ts";
import { Projects } from "../projects/main.ts";
import { answerSchema, questionSchema } from "./content.ts";
import { qualify } from "./failures.ts";
import {
  decideQuestion,
  decideQuestionWait,
  type AnswerAuthority,
  type QuestionCommand,
  type QuestionState,
} from "./question-machine.ts";

type Paths = ReturnType<typeof OperatorHome.resolve>;
type Failure = { reason: string; detail: string };
type Target = Parameters<typeof DeviceState.readQuestion>[1];
type Facts = Extract<ReturnType<typeof DeviceState.readQuestion>, { tag: "Ok" }>["value"];
type Row = NonNullable<Facts["question"]>;
type Selector = { paths: Paths; cwd: string; sourceId: string; assignment: string; key: string };

// The wait reads only device state, so it can look often without an external limit.
const pollMs = 1000;
const stateSchema = z.enum(["open", "awaiting_person", "answered", "withdrawn", "abandoned"]);

/** Carry an earlier step's refusal or defect into the command result. Its callback never runs. */
function stop(result: Result<unknown, Failure>): Result<never, Failure> {
  // Stryker disable next-line ArrowFunction: equivalent: the callback runs only for a success, and no caller stops a success
  return result.flatMap(() => stop(result));
}

/** The pane that runs a command. A worker's pane identifies its assignment. */
function caller() {
  const environment = Environment.read();
  return {
    socket: environment.HERDR_SOCKET_PATH ?? null,
    paneId: environment.HERDR_PANE_ID ?? null,
  };
}

function workerPane(): Result<Target, Failure> {
  const { socket, paneId } = caller();
  return socket === null || paneId === null
    ? Err({
        reason: "worker_pane_required",
        detail:
          "Run this command in the Herdr pane that Operator dispatched for the assignment. Nothing changed.",
      })
    : Ok({ by: "pane", socket, paneId });
}

function superAgentTarget(input: Selector) {
  return Projects.current(input).map(({ data }) => ({
    by: "key" as const,
    repository: data.repository,
    checkout: data.checkout,
    sourceId: input.sourceId,
    assignment: input.assignment,
  }));
}

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

function now() {
  return new Date().toISOString();
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
      return change(input.paths, target.value, input.key, "answer", () => ({
        answer: text,
        answeredBy: input.by,
        answeredAt: now(),
      }))
        .flatMap(recordedSummary)
        .map((data) => ({ reason: "question_answered", data }));
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
    if (reason !== null) return Ok({ reason, data: summary(facts, row) });
    // Stryker disable next-line EqualityOperator: no rule: Operator promises no result for a read that ends in the same millisecond as the deadline
    if (Date.now() >= deadline)
      return Ok({ reason: "question_wait_timed_out", data: summary(facts, row) });
    await Bun.sleep(Math.min(pollMs, deadline - Date.now()));
  }
}

/** The worker's blocking read of its own question. It records nothing. */
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
 * Recorded worker questions: the worker asks, waits, and withdraws from its own pane, and the
 * supervising SuperAgent answers with the authority of the answer or moves it to the person.
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
};
