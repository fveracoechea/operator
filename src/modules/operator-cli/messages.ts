import { WorkerQuestions } from "../worker-questions/main.ts";
import type { OperatorHome } from "../operator-home/main.ts";
import { respond } from "./output.ts";
import { recordFlags } from "./questions.ts";

// The worker's commands take no assignment selector, because its pane is the selector.
const commands = {
  send: { required: ["--source", "--assignment", "--key", "--file"], optional: [] },
  ring: { required: ["--source", "--assignment", "--key"], optional: [] },
  close: { required: ["--source", "--assignment", "--key"], optional: [] },
  read: { required: ["--key"], optional: [] },
  ack: { required: ["--key"], optional: ["--file"] },
} as const;
type Command = keyof typeof commands;

const names = Object.keys(commands).filter((name): name is Command =>
  Object.hasOwn(commands, name),
);

export function messageArgs(args: string[]) {
  const [group, name, ...flags] = args;
  const command = group === "message" ? (names.find((known) => known === name) ?? null) : null;
  if (command === null) return null;
  const values = recordFlags(flags, commands[command]);
  if (values === null) return null;
  return {
    command,
    file: values["--file"] ?? null,
    key: values["--key"] ?? "",
    sourceId: values["--source"] ?? "",
    assignment: values["--assignment"] ?? "",
  };
}

const messageExitCodes = {
  invalid_message_input: 2,
  message_io_failed: 1,
  self_steering_refused: 4,
  worker_launch_not_found: 4,
  worker_pane_required: 4,
};

function dispatch(
  input: NonNullable<ReturnType<typeof messageArgs>> & { paths: Paths; cwd: string },
) {
  if (input.command === "send") {
    // Stryker disable next-line StringLiteral: equivalent: the send parser requires --file, so its null fallback is unreachable
    return WorkerQuestions.send({ ...input, file: input.file ?? "" });
  }
  if (input.command === "ring") return WorkerQuestions.ring(input);
  if (input.command === "close") return WorkerQuestions.close(input);
  if (input.command === "read") return WorkerQuestions.read(input);
  return WorkerQuestions.acknowledge(input);
}

type Paths = ReturnType<typeof OperatorHome.resolve>;

export async function runMessages(args: string[], paths: Paths, json: boolean) {
  const parsed = messageArgs(args);
  if (parsed === null) return false;
  const result = await dispatch({ paths, cwd: process.cwd(), ...parsed });
  respond({
    operation: `message_${parsed.command}`,
    result,
    exitCodes: messageExitCodes,
    defect: "message_defect",
    json,
  });
  return true;
}
