import { WorkerQuestions } from "../worker-questions/main.ts";
import type { OperatorHome } from "../operator-home/main.ts";
import { respond } from "./output.ts";

const defaultTimeoutSeconds = 300;

// The worker's commands take no assignment selector, because its pane is the selector.
const commands = {
  ask: { required: ["--file"], optional: [] },
  wait: { required: ["--key"], optional: ["--timeout"] },
  withdraw: { required: ["--key"], optional: [] },
  escalate: { required: ["--source", "--assignment", "--key"], optional: [] },
  // An answer takes a text file or the text itself.
  answer: {
    required: ["--source", "--assignment", "--key", "--by"],
    optional: ["--file", "--text"],
  },
} as const;
type Command = keyof typeof commands;

const names = Object.keys(commands).filter((name): name is Command =>
  Object.hasOwn(commands, name),
);

function commandOf(value: string | undefined) {
  return names.find((name) => name === value) ?? null;
}

/** Parse each flag of a record command once, with a value, and require the command's selector. */
export function recordFlags(
  flags: string[],
  { required, optional }: { required: readonly string[]; optional: readonly string[] },
) {
  const known: readonly string[] = [...required, ...optional];
  const values: Record<string, string> = {};
  let json = false;
  const rest = flags.values();
  for (const flag of rest) {
    if (flag === "--json" && !json) {
      json = true;
      continue;
    }
    const value = rest.next().value;
    if (
      !known.includes(flag) ||
      Object.hasOwn(values, flag) ||
      value === undefined ||
      value.startsWith("--")
    )
      return null;
    values[flag] = value;
  }
  return required.every((flag) => Object.hasOwn(values, flag)) ? values : null;
}

const authorities = ["super-agent", "person"] as const;

function authority(value: string | undefined) {
  return authorities.find((known) => known === value) ?? null;
}

/** A timeout is whole seconds. An answer names its authority, and takes its file or its text. */
function shaped(command: Command, values: Record<string, string>) {
  const timeout = values["--timeout"];
  if (timeout !== undefined && !/^\d{1,5}$/.test(timeout)) return false;
  if (command !== "answer") return true;
  const authorized = authority(values["--by"]) !== null;
  return authorized && Object.hasOwn(values, "--file") !== Object.hasOwn(values, "--text");
}

export function questionArgs(args: string[]) {
  const [group, name, ...flags] = args;
  const command = group === "question" ? commandOf(name) : null;
  if (command === null) return null;
  const values = recordFlags(flags, commands[command]);
  if (values === null || !shaped(command, values)) return null;
  const timeout = values["--timeout"];
  const by = authority(values["--by"]);
  return {
    command,
    file: values["--file"] ?? "",
    text: values["--text"] ?? null,
    key: values["--key"] ?? "",
    sourceId: values["--source"] ?? "",
    assignment: values["--assignment"] ?? "",
    by: by ?? authorities[0],
    timeoutSeconds: timeout === undefined ? defaultTimeoutSeconds : Number(timeout),
  };
}

const questionExitCodes = {
  invalid_question_input: 2,
  question_io_failed: 1,
  self_decision_refused: 4,
  worker_launch_not_found: 4,
  worker_pane_required: 4,
};

export async function runQuestions(
  args: string[],
  paths: ReturnType<typeof OperatorHome.resolve>,
  json: boolean,
) {
  const parsed = questionArgs(args);
  if (parsed === null) return false;
  const selected = { paths, cwd: process.cwd(), ...parsed };
  const result = await (parsed.command === "ask"
    ? WorkerQuestions.ask(selected)
    : parsed.command === "wait"
      ? WorkerQuestions.wait(selected)
      : parsed.command === "withdraw"
        ? WorkerQuestions.withdraw(selected)
        : parsed.command === "escalate"
          ? WorkerQuestions.escalate(selected)
          : WorkerQuestions.answer(selected));
  const operation = `question_${parsed.command}`;
  respond({ operation, result, exitCodes: questionExitCodes, defect: "question_defect", json });
  return true;
}
