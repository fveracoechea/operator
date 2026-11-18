import { WorkerDispatch } from "../worker-dispatch/main.ts";
import { WorkSources } from "../work-sources/main.ts";
import { PullRequests } from "../pull-requests/main.ts";
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
  if (args[0] !== "dispatch" && args[0] !== "abandon") return null;
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
      (flag !== "--source" && flag !== "--assignment" && flag !== "--after-pid") ||
      Object.hasOwn(values, flag) ||
      value === undefined ||
      value.startsWith("--")
    )
      return null;
    values[flag] = value;
  }
  return dispatchTarget(values, args[0]);
}

function dispatchTarget(values: Record<string, string>, operation: "dispatch" | "abandon") {
  const sourceId = values["--source"];
  const assignment = values["--assignment"];
  if (sourceId === undefined || assignment === undefined) return null;
  const afterPid = values["--after-pid"];
  if (operation === "abandon")
    return afterPid === undefined ? { operation, sourceId, assignment } : null;
  if (afterPid !== undefined && !/^\d{1,10}$/.test(afterPid)) return null;
  return {
    operation: "dispatch" as const,
    sourceId,
    assignment,
    afterPid: afterPid === undefined ? null : Number(afterPid),
  };
}

export const dispatchExitCodes = {
  kind_not_dispatchable: 4,
  assignment_not_dispatchable: 4,
  running_cap_reached: 4,
  launch_failed: 1,
  launch_interrupted: 1,
  dispatch_io_failed: 1,
  preparation_failed: 1,
  preparation_io_failed: 1,
  herdr_failed: 1,
  herdr_no_answer: 1,
  herdr_invalid_response: 1,
  host_metadata_failed: 1,
  handoff_running: 4,
  handoff_not_found: 4,
  herdr_session_mismatch: 4,
  handoff_continuation_refused: 4,
  handoff_publication_timed_out: 4,
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
    ? PullRequests.dispatch({
        paths,
        cwd: process.cwd(),
        sourceId: parsed.sourceId,
        assignment: parsed.assignment,
        afterPid: parsed.afterPid,
      }).map((data) => ({ reason: "worker_launched", data }))
    : parsed.operation === "abandon"
      ? WorkSources.abandon({
          paths,
          cwd: process.cwd(),
          sourceId: parsed.sourceId,
          assignment: parsed.assignment,
        }).map(({ next, ...data }) => ({ reason: "assignment_abandoned", data, next }))
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
