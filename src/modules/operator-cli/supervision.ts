import { WorkSources } from "../work-sources/main.ts";
import type { OperatorHome } from "../operator-home/main.ts";
import { failure } from "./output.ts";

// The SuperAgent commands that coordinate one source's work, by their first two arguments. A wait
// coordinates only with --wait. Reads, worker commands, and commands that carry the person's
// instruction are not listed.
const coordination: Record<string, (args: string[]) => string | null> = {
  dispatch: () => "dispatch",
  abandon: () => "abandon",
  next: (args) => (args.includes("--wait") ? "next_wait" : null),
  report: ([, command]) =>
    command === "accept" || command === "return" ? `report_${command}` : null,
  question: ([, command]) =>
    command === "escalate" || command === "answer" ? `question_${command}` : null,
  message: ([, command]) =>
    command === "send" || command === "ring" || command === "close" ? `message_${command}` : null,
  cleanup: () => "cleanup",
  handoff: () => "handoff",
};

/** The operation and source of a coordination command, or null for any other arguments. */
export function coordinatedSource(args: string[]) {
  const [group] = args;
  // Stryker disable next-line ConditionalExpression: equivalent: an unlisted group has no entry, so the lookup below answers null too
  if (group === undefined || !Object.hasOwn(coordination, group)) return null;
  const operation = coordination[group]?.(args) ?? null;
  const at = args.indexOf("--source");
  const sourceId = at === -1 ? undefined : args[at + 1];
  if (operation === null || sourceId === undefined || args.includes("--person-instructed"))
    return null;
  return { operation, sourceId };
}

/**
 * Refuses a coordination command from an agent session that does not supervise its source, and
 * returns whether it refused. Every other outcome, also a failed read, leaves the command to run
 * and report its own refusal.
 */
export async function refuseUnsupervised(
  args: string[],
  paths: ReturnType<typeof OperatorHome.resolve>,
  json: boolean,
) {
  const command = coordinatedSource(args);
  if (command === null) return false;
  const checked = await WorkSources.checkSupervisor({
    paths,
    cwd: process.cwd(),
    sourceId: command.sourceId,
  });
  if (checked.tag !== "Err" || checked.error.reason !== "source_supervised_elsewhere") return false;
  failure(command.operation, checked.error.reason, checked.error.detail, 4, json);
  return true;
}
