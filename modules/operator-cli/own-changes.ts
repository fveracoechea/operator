import { Environment } from "../environment/main.ts";
import { WorkSources } from "../work-sources/main.ts";
import type { OperatorHome } from "../operator-home/main.ts";

// The SuperAgent commands that change a source's next actions. A wait from the same pane never
// returns for their changes. A worker's commands and the waits themselves are not here.
const supervisorCommands = new Set([
  "dispatch",
  "cleanup",
  "handoff",
  "source register",
  "source reset",
  "message send",
  "message ring",
  "message close",
  "question answer",
  "question escalate",
  "report accept",
  "report return",
  "internal-review skip",
]);

function flagValue(args: string[], flag: string) {
  const index = args.indexOf(flag);
  const value = index === -1 ? undefined : args[index + 1];
  return value === undefined || value.startsWith("--") ? undefined : value;
}

/** The source and assignment that a SuperAgent command changes, or null for another command. */
export function ownChangeSelector(args: string[]) {
  const [group, name] = args;
  const command = supervisorCommands.has(String(group))
    ? String(group)
    : `${String(group)} ${String(name)}`;
  if (!supervisorCommands.has(command)) return null;
  return { sourceId: flagValue(args, "--source"), assignment: flagValue(args, "--assignment") };
}

/**
 * Runs the command, and when it is a SuperAgent command from a Herdr pane, records the actions
 * that it added as returned by that pane's coordination waits.
 */
export async function withOwnChanges(
  args: string[],
  paths: ReturnType<typeof OperatorHome.resolve>,
  run: () => Promise<void>,
) {
  const selector = ownChangeSelector(args);
  const paneId = Environment.read().HERDR_PANE_ID;
  if (selector === null || paneId === undefined || paneId === "") return run();
  return WorkSources.acknowledgeOwnChange({ paths, cwd: process.cwd(), paneId, ...selector }, run);
}
