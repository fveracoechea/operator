import { WorkSources } from "../work-sources/main.ts";
import type { OperatorHome } from "../operator-home/main.ts";
import { failure } from "./output.ts";

// Each command's value flag, and whether the command requires it.
const commands = {
  register: { flag: "--file", required: true },
  show: { flag: "--source", required: true },
  reset: { flag: "--source", required: true },
  prune: { flag: null, required: false },
} as const;

function isCommand(command: string | undefined): command is keyof typeof commands {
  return command !== undefined && Object.hasOwn(commands, command);
}

function sourceOperation(group: string | undefined, command: string | undefined) {
  if (group === "next") return "next" as const;
  return group === "source" && isCommand(command) ? command : null;
}

export function sourceArgs(args: string[]) {
  const [group, command] = args;
  const operation = sourceOperation(group, command);
  if (operation === null) return null;
  const rule = operation === "next" ? { flag: "--source", required: false } : commands[operation];
  const flags = sourceFlags(
    args.slice(operation === "next" ? 1 : 2),
    rule.flag,
    operation === "reset",
  );
  if (flags === null || (rule.required && flags.value === undefined)) return null;
  return {
    operation,
    file: operation === "register" ? flags.value : undefined,
    sourceId: operation === "register" ? undefined : flags.value,
    personInstructed: flags.personInstructed,
  };
}

function sourceFlags(flags: string[], valueFlag: string | null, instructed: boolean) {
  let value: string | undefined;
  let json = false;
  let personInstructed = false;
  for (let index = 0; index < flags.length; index++) {
    const flag = flags[index];
    if (flag === "--json" && !json) {
      json = true;
      continue;
    }
    if (flag === "--person-instructed" && instructed && !personInstructed) {
      personInstructed = true;
      continue;
    }
    if (valueFlag === null || flag !== valueFlag || value !== undefined) return null;
    value = flags[++index];
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
  const { operation, file, sourceId } = parsed;
  if (operation === "register" && file !== undefined)
    return WorkSources.register({ ...input, file });
  if (operation === "show" && sourceId !== undefined)
    return WorkSources.show({ ...input, sourceId });
  if (operation === "reset" && sourceId !== undefined)
    return WorkSources.reset({ ...input, sourceId, personInstructed: parsed.personInstructed });
  if (operation === "prune") return WorkSources.prune(input);
  return WorkSources.next({ ...input, sourceId });
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
