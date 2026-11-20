import { Readiness } from "../readiness/main.ts";
import type { OperatorHome } from "../operator-home/main.ts";
import { failure, printRefusal, outputContext, contextFailure } from "./output.ts";
import type { ResultContext } from "../../lib/cli-result.ts";
import { workflowRefusal } from "./workflow-refusal.ts";

export async function runReadiness(
  args: string[],
  paths: ReturnType<typeof OperatorHome.resolve>,
  json: boolean,
) {
  if (args[0] !== "ready" || args.slice(1).some((flag) => flag !== "--json") || args.length > 2)
    return false;
  const result = await Readiness.check(paths);
  if (result.tag === "Defect")
    failure(
      "ready",
      "readiness_defect",
      String(result.cause),
      1,
      json,
      workflowRefusal("ready", "readiness_defect", {}),
    );
  else if (result.tag === "Err")
    failure("ready", result.error.reason, result.error.detail, 1, json, result.error);
  else reportReadiness(result.value, json);
  return true;
}

function reportReadiness(
  value: Extract<Awaited<ReturnType<typeof Readiness.check>>, { tag: "Ok" }>["value"],
  json: boolean,
) {
  const worker = outputContext();
  if (worker.failure !== undefined) {
    contextFailure("ready", worker.failure, json);
    return;
  }
  const ready = value.blockers.length === 0;
  const context: ResultContext = {
    next: {
      decider: "super-agent",
      question:
        "Which readiness blockers should be resolved next, and which named person decisions must be requested?",
    },
    state: { blockers: value.blockers.map((blocker) => blocker.reason) },
  };
  const recovery: Partial<ResultContext> = {};
  if (!ready) {
    recovery.next = context.next;
    recovery.state = context.state;
  }
  if (json || ready)
    console.log(
      JSON.stringify(
        {
          schemaVersion: 1,
          operation: "ready",
          outcome: ready ? "completed" : "blocked",
          reason: ready ? "ready" : "not_ready",
          blockers: value.blockers,
          warnings: value.warnings,
          data: { staticOnly: true },
          ...worker,
          ...recovery,
        },
        null,
        json ? undefined : 2,
      ),
    );
  if (!ready)
    printRefusal(
      "not_ready",
      value.blockers
        .map(
          (blocker, index) =>
            `[${index + 1}] ${blocker.reason}${"tool" in blocker ? ` (${blocker.tool})` : ""}: ${blocker.detail}`,
        )
        .join("; "),
      value.blockers,
    );
  process.exitCode = ready ? 0 : 3;
}
