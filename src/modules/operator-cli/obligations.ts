import { Obligations } from "../obligations/main.ts";
import type { OperatorHome } from "../operator-home/main.ts";
import { respond } from "./output.ts";
import { recordFlags } from "./questions.ts";

// The SuperAgent names the source, because the ledger belongs to the source, not to a worker.
const commands = {
  add: { required: ["--source", "--key", "--kind", "--file"], optional: ["--reference"] },
  close: { required: ["--source", "--key"], optional: [] },
  list: { required: ["--source"], optional: [] },
} as const;
type Command = keyof typeof commands;

const names = Object.keys(commands).filter((name): name is Command =>
  Object.hasOwn(commands, name),
);

export function obligationArgs(args: string[]) {
  const [group, name, ...flags] = args;
  const command = group === "obligation" ? (names.find((known) => known === name) ?? null) : null;
  if (command === null) return null;
  const values = recordFlags(flags, commands[command]);
  if (values === null) return null;
  return {
    command,
    sourceId: values["--source"] ?? "",
    file: values["--file"] ?? "",
    key: values["--key"] ?? "",
    kind: values["--kind"] ?? "",
    reference: values["--reference"],
  };
}

const obligationExitCodes = {
  invalid_obligation_input: 2,
  obligation_io_failed: 1,
  obligation_exists: 4,
  obligation_not_found: 4,
  obligation_not_open: 4,
  source_not_open: 4,
  source_not_found: 4,
};

export async function runObligations(
  args: string[],
  paths: ReturnType<typeof OperatorHome.resolve>,
  json: boolean,
) {
  const parsed = obligationArgs(args);
  if (parsed === null) return false;
  const selected = { paths, cwd: process.cwd(), ...parsed };
  const result = await (parsed.command === "add"
    ? Obligations.add(selected)
    : parsed.command === "close"
      ? Obligations.close(selected)
      : Obligations.list(selected));
  respond({
    operation: `obligation_${parsed.command}`,
    result,
    exitCodes: obligationExitCodes,
    defect: "obligation_defect",
    json,
  });
  return true;
}
