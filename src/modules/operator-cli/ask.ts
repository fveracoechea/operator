import { WorkSources } from "../work-sources/main.ts";
import type { OperatorHome } from "../operator-home/main.ts";
import { respond } from "./output.ts";
import { dispatchExitCodes, dispatchRegistered } from "./dispatch.ts";

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
      (flag !== "--file" && flag !== "--profile") ||
      Object.hasOwn(values, flag) ||
      value === undefined ||
      value.startsWith("--")
    )
      return null;
    values[flag] = value;
  }
  const file = values["--file"];
  const profile = values["--profile"];
  if (file === undefined || file.trim() === "") return null;
  if (!/^[a-z][a-z0-9-]*$/.test(profile ?? "default")) return null;
  return { file, profile };
}

/**
 * Registers an answer-kind one-off source and dispatches its worker. A failed
 * dispatch keeps the registered source, so its detail names the dispatch to run again. ADR-0027.
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
    registered.tag === "Ok"
      ? (await dispatchRegistered(input, registered.value, "question")).map((data) => ({
          reason: "question_dispatched",
          data,
        }))
      : registered;
  respond({ operation: "ask", result, exitCodes: dispatchExitCodes, defect: "ask_defect", json });
  return true;
}
