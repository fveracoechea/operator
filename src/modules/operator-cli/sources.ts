import { WorkSources } from "../work-sources/main.ts";
import type { OperatorHome } from "../operator-home/main.ts";
import { respond } from "./output.ts";
import { withNext } from "./next.ts";

const sourceCommands = ["register", "show", "reset", "take-over", "prune"] as const;
const defaultTimeoutSeconds = 300;

// Each operation's value flag. Only prune and next run without their value.
const valueFlags = {
  register: "--file",
  show: "--source",
  reset: "--source",
  "take-over": "--source",
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
  // Only next waits or shows the whole board, so every other operation keeps those flags as unknown.
  const waiting =
    operation === "next"
      ? waitFlags(args.slice(1))
      : { flags: args.slice(2), wait: false, timeoutSeconds: undefined, all: false };
  if (waiting === null) return null;
  const flags = sourceFlags(
    waiting.flags,
    valueFlags[operation],
    operation === "reset" || operation === "take-over",
  );
  if (flags === null) return null;
  const { value, personInstructed } = flags;
  const { all } = waiting;
  if (waiting.wait)
    return {
      operation: "next_wait" as const,
      sourceId: value,
      personInstructed,
      timeoutSeconds: waiting.timeoutSeconds ?? defaultTimeoutSeconds,
      all,
    };
  if (operation === "next") return { operation, sourceId: value, personInstructed, all };
  if (operation === "prune") return { operation, sourceId: value, personInstructed };
  if (value === undefined) return null;
  return operation === "register"
    ? { operation, file: value, personInstructed }
    : { operation, sourceId: value, personInstructed };
}

/**
 * Takes the wait and board flags of next and leaves its other flags. A timeout belongs only to a
 * wait, and `--all` asks for the whole board rather than only what changed or still needs work.
 */
function waitFlags(flags: string[]) {
  const others: string[] = [];
  let wait = false;
  let all = false;
  let timeoutSeconds: number | undefined;
  const rest = flags.values();
  for (const flag of rest) {
    if (flag === "--wait" && !wait) wait = true;
    else if (flag === "--all" && !all) all = true;
    else if (flag === "--timeout" && timeoutSeconds === undefined) {
      // An absent value reads as "undefined", which the pattern refuses.
      const seconds = String(rest.next().value);
      if (!/^\d{1,5}$/.test(seconds)) return null;
      timeoutSeconds = Number(seconds);
    } else if (flag === "--wait" || flag === "--all" || flag === "--timeout") return null;
    else others.push(flag);
  }
  if (timeoutSeconds !== undefined && !wait) return null;
  return { flags: others, wait, timeoutSeconds, all };
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
  "take-over": "source_taken_over",
  prune: "sources_pruned",
  next: "next_actions_read",
} as const;

type Parsed = NonNullable<ReturnType<typeof sourceArgs>>;

function execute(
  parsed: Exclude<Parsed, { operation: "next_wait" }>,
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
  if (parsed.operation === "take-over")
    return WorkSources.takeOver({
      ...input,
      sourceId: parsed.sourceId,
      personInstructed: parsed.personInstructed,
    });
  if (parsed.operation === "prune") return WorkSources.prune(input);
  return WorkSources.next({ ...input, sourceId: parsed.sourceId, all: parsed.all });
}

export async function runSources(
  args: string[],
  paths: ReturnType<typeof OperatorHome.resolve>,
  json: boolean,
) {
  const parsed = sourceArgs(args);
  if (parsed === null) return false;
  const input = { paths, cwd: process.cwd() };
  // A wait names its own result: the changed actions or the timeout.
  const executed =
    parsed.operation === "next_wait"
      ? await WorkSources.wait({
          ...input,
          sourceId: parsed.sourceId,
          timeoutSeconds: parsed.timeoutSeconds,
          all: parsed.all,
        })
      : (await execute(parsed, input)).map((data) => ({
          reason: completed[parsed.operation],
          data,
        }));
  const result = executed.map((value) => {
    if (value.data === undefined || !("sources" in value.data)) return value;
    return {
      ...value,
      next: {
        why:
          value.data.sources.length === 0
            ? "No next actions to report."
            : "Follow the next step on the applicable row.",
      },
      data: {
        ...value.data,
        sources: value.data.sources.map((source) => {
          const described = {
            ...source,
            actions: source.actions.map((row) => withNext(source.id, row)),
          };
          if ("waits" in source)
            return { ...described, waits: source.waits.map((row) => withNext(source.id, row)) };
          return described;
        }),
      },
    };
  });
  const operation = parsed.operation.startsWith("next")
    ? parsed.operation
    : `source_${parsed.operation.replace("-", "_")}`;
  respond({
    operation,
    result,
    exitCodes: sourceExitCodes,
    defect: "source_defect",
    json,
  });
  return true;
}
