import { WorkSources } from "../work-sources/main.ts";
import type { OperatorHome } from "../operator-home/main.ts";
import { failure } from "./output.ts";

export function sourceArgs(args: string[]) {
  const [group, command] = args;
  const operation =
    group === "next"
      ? "next"
      : group === "source" && (command === "register" || command === "show")
        ? command
        : null;
  if (operation === null) return null;
  const flags = sourceFlags(
    args.slice(group === "next" ? 1 : 2),
    operation === "register" ? "--file" : "--source",
  );
  if (flags === null || (operation !== "next" && flags.value === undefined)) return null;
  return {
    operation,
    file: operation === "register" ? flags.value : undefined,
    sourceId: operation === "register" ? undefined : flags.value,
  };
}

function sourceFlags(flags: string[], valueFlag: string) {
  let value: string | undefined;
  let json = false;
  for (let index = 0; index < flags.length; index++) {
    const flag = flags[index];
    if (flag === "--json" && !json) {
      json = true;
      continue;
    }
    if (flag !== valueFlag || value !== undefined) return null;
    value = flags[++index];
    if (value === undefined || value.startsWith("--")) return null;
  }
  return { value };
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
      "project_io_failed",
      "settings_io_failed",
    ].includes(reason)
  )
    return 1;
  return 3;
}

export async function runSources(
  args: string[],
  paths: ReturnType<typeof OperatorHome.resolve>,
  json: boolean,
) {
  const parsed = sourceArgs(args);
  if (parsed === null) return false;
  const input = { paths, cwd: process.cwd(), sourceId: parsed.sourceId };
  const result = await (parsed.operation === "register" && parsed.file !== undefined
    ? WorkSources.register({ ...input, file: parsed.file })
    : parsed.operation === "show" && parsed.sourceId !== undefined
      ? WorkSources.show({ ...input, sourceId: parsed.sourceId })
      : WorkSources.next(input));
  const operation = parsed.operation === "next" ? "next" : `source_${parsed.operation}`;
  if (result.tag === "Ok") {
    console.log(
      JSON.stringify(
        {
          schemaVersion: 1,
          operation,
          outcome: "completed",
          reason:
            parsed.operation === "register"
              ? "source_registered"
              : parsed.operation === "show"
                ? "source_read"
                : "next_actions_read",
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
