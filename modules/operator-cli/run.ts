import packageJson from "../../package.json" with { type: "json" };
import { hasCrewArguments, hasSelectionOrProbeArguments, parseArguments } from "./arguments.ts";
import { runAttempt } from "./attempt-command.ts";
import { runCrewOwn } from "./crew-command.ts";
import { runInstall } from "./install-command.ts";
import { runSetup } from "./setup-command.ts";
import { exitCodeByOutcome, writeJsonResult } from "./result.ts";
import { usage } from "./usage.ts";
import { runWork } from "./work-command.ts";

const OPERATOR_VERSION = packageJson.version;
const SUPPORTED_BUN_RANGE = packageJson.engines.bun;

function rejectArguments(json: boolean): void {
  if (json) {
    writeJsonResult({
      outcome: "invalid",
      reason: "invalid_arguments",
      blockers: [],
      operation: "parse_arguments",
    });
  }
  console.error(usage);
  process.exitCode = exitCodeByOutcome.invalid;
}

export async function run(args: string[]): Promise<void> {
  // The Bun check runs before any command so an unsupported runtime never writes files.
  if (!Bun.semver.satisfies(Bun.version, SUPPORTED_BUN_RANGE)) {
    if (args.includes("--json")) {
      writeJsonResult({
        outcome: "failed",
        reason: "unsupported_bun",
        blockers: [
          {
            reason: "unsupported_bun",
            required: SUPPORTED_BUN_RANGE,
            actual: Bun.version,
          },
        ],
        operation: "startup",
        data: {
          operatorVersion: OPERATOR_VERSION,
          bunVersion: Bun.version,
        },
      });
    }
    console.error(`operator: Bun ${SUPPORTED_BUN_RANGE} is required; running ${Bun.version}.`);
    process.exitCode = exitCodeByOutcome.failed;
    return;
  }

  const [command, ...rest] = args;

  if (command === "install") {
    const parsed = parseArguments(rest);
    if (
      parsed.unsupported.length > 0 ||
      parsed.approvedPlan !== undefined ||
      hasCrewArguments(parsed) ||
      hasSelectionOrProbeArguments(parsed)
    ) {
      rejectArguments(parsed.json);
      return;
    }
    await runInstall(parsed);
    return;
  }

  if (command === "setup") {
    // A setup request names its operation in leading words, then carries only flags.
    const firstFlag = rest.findIndex((word) => word.startsWith("--"));
    const words = firstFlag === -1 ? rest : rest.slice(0, firstFlag);
    const parsed = parseArguments(firstFlag === -1 ? [] : rest.slice(firstFlag));
    if (
      parsed.unsupported.length > 0 ||
      hasCrewArguments(parsed) ||
      (await runSetup(words, parsed)) !== "reported"
    ) {
      rejectArguments(parsed.json);
    }
    return;
  }

  if (command === "crew" || command === "work" || command === "attempt") {
    // A crew request names its operation in leading words, then carries only flags.
    const firstFlag = rest.findIndex((word) => word.startsWith("--"));
    const words = firstFlag === -1 ? rest : rest.slice(0, firstFlag);
    const parsed = parseArguments(firstFlag === -1 ? [] : rest.slice(firstFlag));
    if (
      parsed.unsupported.length > 0 ||
      parsed.targets.length > 0 ||
      parsed.approvedPlan !== undefined ||
      // Only crew ownership can be taken over, so any other command refuses the flag.
      (command !== "crew" && parsed.takeover) ||
      // A dispatch fixes the selection it launches with, so only it reads a selection override.
      parsed.approvedProbe !== undefined ||
      (!(command === "attempt" && words[0] === "dispatch") && hasSelectionOrProbeArguments(parsed))
    ) {
      rejectArguments(parsed.json);
      return;
    }

    const handled =
      command === "crew"
        ? words.length === 1 && words[0] === "own"
          ? await runCrewOwn(parsed)
          : "invalid-arguments"
        : command === "attempt"
          ? await runAttempt(words, parsed)
          : await runWork(words, parsed);
    if (handled !== "reported") {
      rejectArguments(parsed.json);
    }
    return;
  }

  if (args.length === 2 && args.includes("--version") && args.includes("--json")) {
    writeJsonResult({
      outcome: "completed",
      reason: "version_reported",
      blockers: [],
      operation: "version",
      data: {
        operatorVersion: OPERATOR_VERSION,
        bunVersion: Bun.version,
      },
    });
    process.exitCode = exitCodeByOutcome.completed;
    return;
  }

  if (args.length === 1 && args[0] === "--version") {
    console.log(`operator ${OPERATOR_VERSION}`);
    process.exitCode = exitCodeByOutcome.completed;
    return;
  }

  rejectArguments(args.includes("--json"));
}
