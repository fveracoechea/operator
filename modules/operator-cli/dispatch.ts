import { WorkerDispatch } from "../worker-dispatch/main.ts";
import type { OperatorHome } from "../operator-home/main.ts";
import { respond } from "./output.ts";

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

const dispatchExitCodes = {
  assignment_not_dispatchable: 4,
  launch_failed: 1,
  launch_interrupted: 1,
  dispatch_io_failed: 1,
  preparation_failed: 1,
  preparation_io_failed: 1,
  herdr_failed: 1,
  herdr_no_answer: 1,
  herdr_invalid_response: 1,
  host_metadata_failed: 1,
};

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
  respond({
    operation: parsed.operation,
    result,
    exitCodes: dispatchExitCodes,
    defect: "dispatch_defect",
    json,
  });
  return true;
}
