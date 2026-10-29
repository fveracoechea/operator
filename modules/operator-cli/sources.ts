import { WorkSources } from "../work-sources/main.ts";
import type { OperatorHome } from "../operator-home/main.ts";
import { failure } from "./output.ts";

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

function sourceExitCode(reason: string) {
  if (reason === "invalid_source_plan") return 2;
  if (
    ["source_parent_open", "controller_mismatch", "controller_identity_mismatch"].includes(reason)
  )
    return 4;
  if (
    [
      "state_busy",
      "state_io_failed",
      "source_io_failed",
      "source_prune_failed",
      "project_io_failed",
      "settings_io_failed",
    ].includes(reason)
  )
    return 1;
  return 3;
}

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
  if (result.tag === "Ok") {
    console.log(
      JSON.stringify(
        {
          schemaVersion: 1,
          operation,
          outcome: "completed",
          reason: completed[parsed.operation],
          blockers: [],
          data: result.value,
        },
        null,
        json ? undefined : 2,
      ),
    );
    process.exitCode = 0;
  } else if (result.tag === "Err") {
    const reason = result.error.reason;
    failure(operation, reason, result.error.detail, sourceExitCode(reason), json);
  } else failure(operation, "source_defect", String(result.cause), 1, json);
  return true;
}
