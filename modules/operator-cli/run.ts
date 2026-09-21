import packageJson from "../../package.json" with { type: "json" };
import { parseArguments } from "./arguments.ts";
import { runInstall } from "./install-command.ts";
import { runSetup } from "./setup-command.ts";
import { exitCodeByOutcome, writeJsonResult } from "./result.ts";
import { usage } from "./usage.ts";

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
    if (parsed.unsupported.length > 0 || parsed.approvedPlan !== undefined) {
      rejectArguments(parsed.json);
      return;
    }
    await runInstall(parsed);
    return;
  }

  if (command === "setup") {
    const subcommand = rest[0]?.startsWith("--") ? undefined : rest[0];
    const parsed = parseArguments(subcommand === undefined ? rest : rest.slice(1));
    if (parsed.unsupported.length > 0 || (await runSetup(subcommand, parsed)) !== "reported") {
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
