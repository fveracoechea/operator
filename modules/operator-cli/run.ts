import packageJson from "../../package.json" with { type: "json" };
import { exitCodeByOutcome, writeJsonResult } from "./result.ts";

const OPERATOR_VERSION = packageJson.version;
const SUPPORTED_BUN_RANGE = packageJson.engines.bun;

export async function run(args: string[]): Promise<void> {
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

  if (args.includes("--json")) {
    writeJsonResult({
      outcome: "invalid",
      reason: "invalid_arguments",
      blockers: [],
      operation: "parse_arguments",
    });
  }
  console.error("Usage: operator --version [--json]");
  process.exitCode = exitCodeByOutcome.invalid;
}
