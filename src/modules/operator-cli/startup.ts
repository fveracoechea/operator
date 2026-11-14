import { OperatorRelease } from "../operator-release/main.ts";
import { Environment } from "../environment/main.ts";
import { OperatorHome } from "../operator-home/main.ts";
import { DeviceState } from "../device-state/main.ts";
import { fromThrowable } from "unthrown";
import { z } from "zod";
import { runClaudeHook } from "./claude.ts";
import { runOpenCodeHook } from "./opencode.ts";
import { herdrEventWithoutState } from "./dispatch.ts";
import { exitCodeOf, failure } from "./output.ts";
import { projectArgs } from "./projects.ts";
import { workflowArguments } from "./usage.ts";
import { workflowRefusal } from "./workflow-refusal.ts";
import type { ResultContext } from "../../lib/cli-result.ts";

type OperatorPaths = ReturnType<typeof OperatorHome.resolve>;

function context(args: string[], reason: string, checked: ResultContext = {}) {
  return workflowArguments(args) ? workflowRefusal("workflow_startup", reason, checked) : checked;
}

function startupPaths(args: string[], json: boolean) {
  const startup = fromThrowable(
    () => OperatorHome.resolve(Environment.read()),
    (cause, defect) => (cause instanceof z.ZodError ? cause.message : defect(cause)),
  )();
  if (startup.tag === "Ok") return startup.value;
  if (startup.tag === "Err")
    failure(
      "startup",
      "invalid_environment",
      startup.error,
      2,
      json,
      workflowArguments(args)
        ? {
            next: {
              decider: "super-agent",
              question: "Which valid device environment should this command use?",
            },
          }
        : {},
    );
  else
    failure(
      "startup",
      "startup_defect",
      String(startup.cause),
      1,
      json,
      context(args, "startup_defect"),
    );
  return null;
}

function supportedRuntime(args: string[], supportedBun: string, json: boolean) {
  if (Bun.semver.satisfies(Bun.version, supportedBun)) return true;
  if (workflowArguments(args)) {
    failure(
      "startup",
      "unsupported_bun",
      `Bun ${supportedBun} is required; running ${Bun.version}.`,
      1,
      json,
      {
        next: {
          decider: "super-agent",
          question: "Which supported Bun runtime should run this command?",
        },
        state: { required: supportedBun, actual: Bun.version },
      },
    );
    return false;
  }
  if (json)
    console.log(
      JSON.stringify({
        schemaVersion: 1,
        operation: "startup",
        outcome: "failed",
        reason: "unsupported_bun",
        blockers: [{ reason: "unsupported_bun", required: supportedBun, actual: Bun.version }],
      }),
    );
  console.error(`operator: Bun ${supportedBun} is required; running ${Bun.version}.`);
  process.exitCode = 1;
  return false;
}

/** Startup checks state compatibility before every command, also help and version. */
function compatibleState(args: string[], paths: OperatorPaths, json: boolean) {
  const compatible = DeviceState.checkCompatibility(
    paths,
    projectArgs(args)?.command === "register",
  );
  if (compatible.tag === "Ok") return true;
  if (compatible.tag === "Err")
    failure(
      "startup",
      compatible.error.reason,
      compatible.error.detail,
      exitCodeOf(compatible.error.reason),
      json,
      context(args, compatible.error.reason, compatible.error),
    );
  else
    failure(
      "startup",
      "startup_defect",
      String(compatible.cause),
      1,
      json,
      context(args, "startup_defect"),
    );
  return false;
}

/** Resolves the paths and release, or reports why no command may run, before any command. */
export async function startup(args: string[], json: boolean) {
  const paths = startupPaths(args, json);
  if (paths === null) return null;
  const release = await OperatorRelease.manifest();
  if (!supportedRuntime(args, release.supportedBun, json)) return null;
  if (await runClaudeHook(args, paths)) return null;
  if (await runOpenCodeHook(args, paths)) return null;
  if (await herdrEventWithoutState(args, paths, json)) return null;
  if (!compatibleState(args, paths, json)) return null;
  return { paths, release };
}
