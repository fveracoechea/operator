import { Err, Ok, fromPromise } from "unthrown";
import { z } from "zod";
import { DeviceState } from "../device-state/main.ts";
import { Herdr } from "../herdr/main.ts";
import { doorbell, messageSchema, replySchema } from "./content.ts";
import { qualify } from "./failures.ts";
import { decideMessage, type MessageCommand } from "./message-machine.ts";
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

type Facts = Extract<ReturnType<typeof DeviceState.readMessage>, { tag: "Ok" }>["value"];
type Row = NonNullable<Facts["message"]>;

const stateSchema = z.enum(["pending", "acknowledged", "replied", "closed", "abandoned"]);

function decide(facts: Facts, command: MessageCommand, reply = false) {
  return decideMessage({
    command,
    assignment: facts.assignment,
    launch: facts.launch,
    message:
      facts.message === null
        ? null
        : { key: facts.message.key, state: stateSchema.parse(facts.message.state) },
    reply,
    caller: caller(),
  });
}

/** The message as the SuperAgent and the worker read it. */
function summary(facts: Facts, row: Row) {
  return {
    sourceId: facts.source.id,
    assignment: facts.assignment.key,
    key: row.key,
    state: row.state,
    message: row.message,
    questionKey: row.questionKey,
    sentAt: row.sentAt,
    rungAt: row.rungAt,
    doorbellFailure: row.doorbellFailure,
    acknowledgedAt: row.acknowledgedAt,
    reply: row.reply,
  };
}

function recorded(paths: Paths, target: Target, key: string) {
  return DeviceState.readMessage(paths, target, key).flatMap((facts) =>
    facts.message === null
      ? Err<Failure>({
          reason: "message_not_found",
          detail: `Assignment ${facts.assignment.key} has no steering message ${key}. Nothing changed.`,
        })
      : Ok(summary(facts, facts.message)),
  );
}

/**
 * Type the fixed doorbell line into the worker's pane, outside any write transaction, then record
 * the attempt. A failed doorbell keeps the message pending and shows it as worker attention.
 * A message that the worker or the SuperAgent ended while the doorbell rang keeps its record.
 */
export async function ring(paths: Paths, target: Target, key: string, worker: string) {
  const typed = await Herdr.prompt({ name: worker, text: doorbell(key) });
  if (typed.tag === "Defect") return stop(typed);
  const failure = typed.tag === "Err" ? `${typed.error.reason}: ${typed.error.detail}` : null;
  return DeviceState.changeMessage(paths, target, key, (facts) =>
    Ok(
      facts.message?.state === "pending"
        ? { update: { rungAt: now(), doorbellFailure: failure } }
        : {},
    ),
  ).flatMap(() => recorded(paths, target, key));
}

function launchName(facts: Facts) {
  // Stryker disable next-line OptionalChaining, StringLiteral: equivalent: a send or ring needs a running launch, so the launch is never null here
  return facts.launch?.name ?? "";
}

/** A new pending message, to the latest launch of its assignment, that no doorbell rang yet. */
export function pendingMessage(
  facts: Pick<Facts, "source" | "assignment" | "launch">,
  sent: { key: string; message: string; sentAt: string; questionKey?: string },
): Row {
  return {
    sourceId: facts.source.id,
    assignment: facts.assignment.key,
    key: sent.key,
    // Stryker disable next-line OptionalChaining, StringLiteral: equivalent: a send or an answer belongs to a launch, so the launch is never null here
    launchId: facts.launch?.id ?? "",
    message: sent.message,
    questionKey: sent.questionKey ?? null,
    sentAt: sent.sentAt,
    state: "pending",
    rungAt: null,
    doorbellFailure: null,
    acknowledgedAt: null,
    reply: null,
    endedAt: null,
  };
}

/** Record a message for the running worker, then ring its doorbell outside the transaction. */
async function deliver(input: Omit<Selector, "key">, sent: { key: string; message: string }) {
  const target = await superAgentTarget({ ...input, key: "" });
  if (target.tag !== "Ok") return stop(target);
  const changed = DeviceState.changeMessage(input.paths, target.value, sent.key, (facts) =>
    decide(facts, "send").map(() => ({
      insert: pendingMessage(facts, { key: sent.key, message: sent.message, sentAt: now() }),
    })),
  );
  if (changed.tag !== "Ok") return stop(changed);
  const worker = launchName(changed.value.facts);
  return (await ring(input.paths, target.value, sent.key, worker)).map((data) => ({
    reason: "message_sent",
    data,
  }));
}

function send(input: Omit<Selector, "key"> & { file: string }) {
  return fromPromise(
    async () => deliver(input, messageSchema.parse(JSON.parse(await Bun.file(input.file).text()))),
    (cause, defect) => (cause instanceof Error ? qualify(cause, defect, "message") : defect(cause)),
  ).flatMap((result) => result);
}

/** Another module's operation steers the worker that it hands work to. ADR-0023. */
function steer(input: Omit<Selector, "key"> & { key: string; message: string }) {
  return fromPromise(
    async () => deliver(input, messageSchema.parse({ key: input.key, message: input.message })),
    (cause, defect) => (cause instanceof Error ? qualify(cause, defect, "message") : defect(cause)),
  ).flatMap((result) => result);
}

/** Ring the doorbell of a pending message again, for example after a failed doorbell. */
function ringAgain(input: Selector) {
  return fromPromise(
    async () => {
      const target = await superAgentTarget(input);
      if (target.tag !== "Ok") return stop(target);
      const checked = DeviceState.readMessage(input.paths, target.value, input.key).flatMap(
        (facts) => decide(facts, "ring").map(() => facts),
      );
      if (checked.tag !== "Ok") return stop(checked);
      const worker = launchName(checked.value);
      return (await ring(input.paths, target.value, input.key, worker)).map((data) => ({
        reason: "message_rung",
        data,
      }));
    },
    (cause, defect) => defect(cause),
  ).flatMap((result) => result);
}

function close(input: Selector) {
  return superAgentTarget(input).flatMap((target) =>
    DeviceState.changeMessage(input.paths, target, input.key, (facts) =>
      decide(facts, "close").map(({ state }) => ({ update: { state, endedAt: now() } })),
    )
      .flatMap(() => recorded(input.paths, target, input.key))
      .map((data) => ({ reason: "message_closed", data })),
  );
}

/** The worker reads a message from its own pane. Reading records nothing. */
function read(input: { paths: Paths; key: string }) {
  return workerPane()
    .flatMap((target) => recorded(input.paths, target, input.key))
    .map((data) => ({ reason: "message_read", data }));
}

/** Record the worker's acknowledgement. An acknowledgement without a reply ends the message. */
export function acknowledge(paths: Paths, target: Target, key: string, reply: string | null) {
  return DeviceState.changeMessage(paths, target, key, (facts) =>
    decide(facts, "acknowledge", reply !== null).map(({ state }) => {
      const acknowledgedAt = now();
      const update: Partial<Row> = { state, acknowledgedAt, reply };
      // A reply waits on the SuperAgent. A plain acknowledgement ends the message.
      if (state === "acknowledged") update.endedAt = acknowledgedAt;
      return { update };
    }),
  ).flatMap(() => recorded(paths, target, key));
}

function acknowledgeFromPane(input: { paths: Paths; key: string; file: string | null }) {
  return fromPromise(
    async () => {
      const target = workerPane();
      if (target.tag !== "Ok") return stop(target);
      const reply =
        input.file === null ? null : replySchema.parse(await Bun.file(input.file).text());
      return acknowledge(input.paths, target.value, input.key, reply).map((data) => ({
        reason: reply === null ? "message_acknowledged" : "message_replied",
        data,
      }));
    },
    (cause, defect) => (cause instanceof Error ? qualify(cause, defect, "message") : defect(cause)),
  ).flatMap((result) => result);
}

/**
 * Recorded steering: the supervising SuperAgent sends, rings again, and closes from its own pane,
 * and the worker reads and acknowledges from the pane that Operator dispatched for it.
 */
export const steering = {
  send,
  steer,
  ring: ringAgain,
  close,
  read,
  acknowledge: acknowledgeFromPane,
};
