import { WorkSources } from "../work-sources/main.ts";
import type { OperatorHome } from "../operator-home/main.ts";
import { respond } from "./output.ts";

const sourceCommands = ["register", "show", "reset", "prune"] as const;

// Each operation's value flag. Only prune and next run without their value.
const valueFlags = {
  register: "--file",
  show: "--source",
  reset: "--source",
  prune: null,
  next: "--source",
} as const;

function sourceOperation(group: string | undefined, command: string | undefined) {
  if (group === "next") return "next" as const;
  return group === "source" ? sourceCommands.find((known) => known === command) : undefined;
}

export function sourceArgs(args: string[]) {
  const [group, command] = args;
  const operation = sourceOperation(group, command);
  // Stryker disable next-line ConditionalExpression: equivalent: an unknown operation has no value flag and is not next or prune, so the later checks refuse every input
  if (operation === undefined) return null;
  const flags = sourceFlags(
    args.slice(operation === "next" ? 1 : 2),
    valueFlags[operation],
    operation === "reset",
  );
  if (flags === null) return null;
  const { value, personInstructed } = flags;
  if (operation === "next" || operation === "prune")
    return { operation, sourceId: value, personInstructed };
  if (value === undefined) return null;
  return operation === "register"
    ? { operation, file: value, personInstructed }
    : { operation, sourceId: value, personInstructed };
}

function sourceFlags(flags: string[], valueFlag: string | null, instructed: boolean) {
  let value: string | undefined;
  let json = false;
  let personInstructed = false;
  const rest = flags.values();
  for (const flag of rest) {
    if (flag === "--json" && !json) {
      json = true;
      continue;
    }
    if (flag === "--person-instructed" && instructed && !personInstructed) {
      personInstructed = true;
      continue;
    }
    if (flag !== valueFlag || value !== undefined) return null;
    value = rest.next().value;
    if (value === undefined || value.startsWith("--")) return null;
  }
  return { value, personInstructed };
}

const sourceExitCodes = {
  invalid_source_plan: 2,
  source_parent_open: 4,
  source_io_failed: 1,
  source_prune_failed: 1,
};

const completed = {
  register: "source_registered",
  show: "source_read",
  reset: "source_reset",
  prune: "sources_pruned",
  next: "next_actions_read",
} as const;

function execute(
  parsed: NonNullable<ReturnType<typeof sourceArgs>>,
  input: { paths: ReturnType<typeof OperatorHome.resolve>; cwd: string },
) {
  if (parsed.operation === "register") return WorkSources.register({ ...input, file: parsed.file });
  if (parsed.operation === "show") return WorkSources.show({ ...input, sourceId: parsed.sourceId });
  if (parsed.operation === "reset")
    return WorkSources.reset({
      ...input,
      sourceId: parsed.sourceId,
      personInstructed: parsed.personInstructed,
    });
  if (parsed.operation === "prune") return WorkSources.prune(input);
  return WorkSources.next({ ...input, sourceId: parsed.sourceId });
}

export async function runSources(
  args: string[],
  paths: ReturnType<typeof OperatorHome.resolve>,
  json: boolean,
) {
  const parsed = sourceArgs(args);
  if (parsed === null) return false;
  const result = await execute(parsed, { paths, cwd: process.cwd() });
  const operation = parsed.operation === "next" ? "next" : `source_${parsed.operation}`;
  respond({
    operation,
    result: result.map((data) => ({ reason: completed[parsed.operation], data })),
    exitCodes: sourceExitCodes,
    defect: "source_defect",
    json,
  });
  return true;
}
