import { WorkerDispatch } from "../worker-dispatch/main.ts";
import type { OperatorHome } from "../operator-home/main.ts";
import { failure } from "./output.ts";

function herdrArgs(args: string[]) {
  const [, command, ...flags] = args;
  if (command !== "install" && command !== "event") return null;
  return flags.length <= 1 && flags.every((flag) => flag === "--json")
    ? { operation: `herdr_${command}` as const }
    : null;
}

export function dispatchArgs(args: string[]) {
  if (args[0] === "herdr") return herdrArgs(args);
  if (args[0] !== "dispatch") return null;
  const values: Record<string, string> = {};
  const flags = args.slice(1);
  const rest = flags.values();
  for (const flag of rest) {
    if (flag === "--json" && !values.json) {
      values.json = "yes";
      continue;
    }
    const value = rest.next().value;
    if (
      (flag !== "--source" && flag !== "--assignment") ||
      Object.hasOwn(values, flag) ||
      value === undefined ||
      value.startsWith("--")
    )
      return null;
    values[flag] = value;
  }
  const sourceId = values["--source"];
  const assignment = values["--assignment"];
  if (sourceId === undefined || assignment === undefined) return null;
  return { operation: "dispatch" as const, sourceId, assignment };
}

function exitCode(reason: string) {
  if (
    ["controller_mismatch", "controller_identity_mismatch", "assignment_not_dispatchable"].includes(
      reason,
    )
  )
    return 4;
  if (
    [
      "launch_failed",
      "launch_interrupted",
      "state_busy",
      "state_io_failed",
      "dispatch_io_failed",
      "preparation_failed",
      "preparation_io_failed",
      "herdr_failed",
      "herdr_no_answer",
      "herdr_invalid_response",
      "host_metadata_failed",
      "settings_io_failed",
    ].includes(reason)
  )
    return 1;
  return 3;
}

/**
 * Herdr runs the hook for every pane event on the device. Without device state there is no
 * launch or project to observe, so the event is ignored and the hook succeeds.
 */
export async function herdrEventWithoutState(
  args: string[],
  paths: ReturnType<typeof OperatorHome.resolve>,
  json: boolean,
) {
  if (dispatchArgs(args)?.operation !== "herdr_event" || (await Bun.file(paths.database).exists()))
    return false;
  console.log(
    JSON.stringify(
      {
        schemaVersion: 1,
        operation: "herdr_event",
        outcome: "completed",
        reason: "herdr_event_ignored",
        blockers: [],
        data: { stateMissing: true },
      },
      null,
      json ? undefined : 2,
    ),
  );
  process.exitCode = 0;
  return true;
}

export async function runDispatch(
  args: string[],
  paths: ReturnType<typeof OperatorHome.resolve>,
  json: boolean,
) {
  const parsed = dispatchArgs(args);
  if (parsed === null) return false;
  const result = await (parsed.operation === "dispatch"
    ? WorkerDispatch.dispatch({
        paths,
        cwd: process.cwd(),
        sourceId: parsed.sourceId,
        assignment: parsed.assignment,
      }).map((data) => ({ reason: "worker_launched", data }))
    : parsed.operation === "herdr_install"
      ? WorkerDispatch.installPlugin({ paths })
      : WorkerDispatch.observe({ paths }));
  if (result.tag === "Ok") {
    console.log(
      JSON.stringify(
        {
          schemaVersion: 1,
          operation: parsed.operation,
          outcome: "completed",
          reason: result.value.reason,
          blockers: [],
          data: result.value.data,
        },
        null,
        json ? undefined : 2,
      ),
    );
    process.exitCode = 0;
  } else if (result.tag === "Err")
    failure(
      parsed.operation,
      result.error.reason,
      result.error.detail,
      exitCode(result.error.reason),
      json,
    );
  else failure(parsed.operation, "dispatch_defect", String(result.cause), 1, json);
  return true;
}
