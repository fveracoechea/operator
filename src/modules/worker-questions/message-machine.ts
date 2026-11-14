import { Err, Ok, type Result } from "unthrown";
import type { ResultContext } from "../../lib/cli-result.ts";

export type MessageCommand = "send" | "ring" | "acknowledge" | "close";
export type MessageState = "pending" | "acknowledged" | "replied" | "closed" | "abandoned";
type Pane = { socket: string | null; paneId: string | null };
type Facts = {
  command: MessageCommand;
  assignment: { key: string; state: string };
  launch: { id: string; state: string; paneId: string | null; herdrSocket: string | null } | null;
  /** The recorded message with the command's key, when one was sent. */
  message: { key: string; state: MessageState } | null;
  /** Whether the worker's acknowledgement carries a reply. */
  reply: boolean;
  /** The pane that runs the command, when Herdr supplies one. */
  caller: Pane;
};
type MessageTransition =
  | { insert: true; state: "pending" }
  | { insert: false; state: MessageState };
type Refusal = ResultContext & { reason: string; detail: string };

const ended = ["merged", "completed", "abandoned"];

function refuse(reason: string, detail: string, context: ResultContext) {
  return Err<Refusal>({
    reason,
    detail: `${detail} Nothing changed.`,
    next: { command: "operator next", why: "Read the current message action before retrying." },
    ...context,
  });
}

/** The worker's own pane cannot steer itself. */
function fromWorker({ launch, caller }: Facts) {
  return (
    launch !== null &&
    launch.paneId !== null &&
    caller.paneId === launch.paneId &&
    caller.socket === launch.herdrSocket
  );
}

function running({ assignment, launch }: Facts) {
  return !ended.includes(assignment.state) && launch?.state === "running";
}

function recorded(facts: Facts, from: MessageState[], to: MessageState) {
  const { assignment, message } = facts;
  if (message === null)
    return refuse(
      "message_not_found",
      `Assignment ${assignment.key} has no steering message with this key.`,
      {
        next: {
          decider: "super-agent",
          question: "Which recorded message key should this command target?",
        },
        state: { message: null },
      },
    );
  if (!from.includes(message.state))
    return refuse(
      "message_not_open",
      `Steering message ${message.key} of ${assignment.key} is ${message.state}.`,
      { state: { message: message.state } },
    );
  return Ok<MessageTransition>({ insert: false, state: to });
}

const rules: Record<MessageCommand, (facts: Facts) => Result<MessageTransition, Refusal>> = {
  send(facts) {
    const { assignment, message } = facts;
    if (!running(facts))
      return refuse(
        "assignment_not_running",
        `Assignment ${assignment.key} has no running worker launch.`,
        { state: { assignment: assignment.state, launch: facts.launch?.state ?? null } },
      );
    // A key names one message for the whole assignment, so a retried send cannot deliver twice.
    if (message !== null)
      return refuse(
        "message_key_taken",
        `Assignment ${assignment.key} already has steering message ${message.key}. Send with a new key.`,
        {
          next: {
            decider: "super-agent",
            question: "Which new key should identify this steering message?",
          },
          state: { messageExists: true },
        },
      );
    return Ok({ insert: true, state: "pending" });
  },
  ring(facts) {
    if (!running(facts))
      return refuse(
        "assignment_not_running",
        `Assignment ${facts.assignment.key} has no running worker launch.`,
        { state: { assignment: facts.assignment.state, launch: facts.launch?.state ?? null } },
      );
    return recorded(facts, ["pending"], "pending");
  },
  acknowledge: (facts) => recorded(facts, ["pending"], facts.reply ? "replied" : "acknowledged"),
  close: (facts) => recorded(facts, ["pending", "replied"], "closed"),
};

/**
 * The supervising SuperAgent sends, rings again, and closes, never from the worker's pane. The
 * worker acknowledges from its own pane, with or without a reply. An ended assignment's pending
 * and replied messages are abandoned in the transaction that ends it.
 */
export function decideMessage(facts: Facts): Result<MessageTransition, Refusal> {
  if (facts.command !== "acknowledge" && fromWorker(facts))
    return refuse(
      "self_steering_refused",
      "A WorkerAgent cannot steer its own assignment. The supervising SuperAgent sends from its own pane.",
      {
        next: {
          decider: "super-agent",
          question: "What steering should the worker receive from your own supervising pane?",
        },
        state: { samePane: true, sameServer: true },
      },
    );
  return rules[facts.command](facts);
}
