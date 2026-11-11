import { WorkSources } from "../work-sources/main.ts";
import { WorkerDispatch } from "../worker-dispatch/main.ts";
import type { OperatorHome } from "../operator-home/main.ts";
import { respond } from "./output.ts";

export function askArgs(args: string[]) {
  if (args[0] !== "ask") return null;
  const values: Record<string, string> = {};
  const rest = args.slice(1).values();
  for (const flag of rest) {
    if (flag === "--json" && !values.json) {
      values.json = "yes";
      continue;
    }
    const value = rest.next().value;
    if (
      (flag !== "--question" && flag !== "--profile") ||
      Object.hasOwn(values, flag) ||
      value === undefined ||
      value.startsWith("--")
    )
      return null;
    values[flag] = value;
  }
  const question = values["--question"];
  const profile = values["--profile"];
  if (question === undefined || question.trim() === "") return null;
  if (profile !== undefined && !/^[a-z][a-z0-9-]*$/.test(profile)) return null;
  return { question, profile };
}

const askExitCodes = {
  invalid_source_plan: 2,
  source_parent_open: 4,
  source_io_failed: 1,
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
};

async function dispatchQuestion(
  input: { paths: ReturnType<typeof OperatorHome.resolve>; cwd: string },
  source: { id: string; assignments: { key: string }[] },
) {
  const assignment = source.assignments[0]?.key ?? "";
  const launched = await WorkerDispatch.dispatch({ ...input, sourceId: source.id, assignment });
  if (launched.tag === "Ok")
    return {
      tag: "Ok" as const,
      value: {
        reason: "question_dispatched",
        data: launched.value,
      },
    };
  if (launched.tag === "Defect") return launched;
  const { reason, detail } = launched.error;
  return {
    tag: "Err" as const,
    error: {
      reason,
      detail: `${detail} Source ${source.id} holds the question. Run operator dispatch --source ${source.id} --assignment ${assignment} again.`,
    },
  };
}

/**
 * Registers a research question as its own report source and dispatches its worker. A failed
 * dispatch keeps the registered source, so its detail names the dispatch to run again. ADR-0025.
 */
export async function runAsk(
  args: string[],
  paths: ReturnType<typeof OperatorHome.resolve>,
  json: boolean,
) {
  const parsed = askArgs(args);
  if (parsed === null) return false;
  const input = { paths, cwd: process.cwd() };
  const registered = await WorkSources.ask({ ...input, ...parsed });
  const result =
    registered.tag === "Ok" ? await dispatchQuestion(input, registered.value) : registered;
  respond({ operation: "ask", result, exitCodes: askExitCodes, defect: "ask_defect", json });
  return true;
}
