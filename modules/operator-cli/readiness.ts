import { Readiness } from "../readiness/main.ts";
import type { OperatorHome } from "../operator-home/main.ts";
import { failure } from "./output.ts";

export async function runReadiness(
  args: string[],
  paths: ReturnType<typeof OperatorHome.resolve>,
  json: boolean,
) {
  if (args[0] !== "ready" || args.slice(1).some((flag) => flag !== "--json") || args.length > 2)
    return false;
  const result = await Readiness.check(paths);
  if (result.tag === "Defect") failure("ready", "readiness_defect", String(result.cause), 1, json);
  else if (result.tag === "Err")
    failure("ready", result.error.reason, result.error.detail, 1, json);
  else if (result.tag === "Ok") {
    const ready = result.value.blockers.length === 0;
    console.log(
      JSON.stringify(
        {
          schemaVersion: 1,
          operation: "ready",
          outcome: ready ? "completed" : "blocked",
          reason: ready ? "ready" : "not_ready",
          blockers: result.value.blockers,
          data: { staticOnly: true },
        },
        null,
        json ? undefined : 2,
      ),
    );
    process.exitCode = ready ? 0 : 3;
  }
  return true;
}
