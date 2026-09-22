import { OperatorRelease } from "../operator-release/main.ts";
import {
  hasCrewArguments,
  hasSelectionOrProbeArguments,
  hasUpdateArguments,
  type ParsedArguments,
  parseArguments,
  splitRequest,
} from "./arguments.ts";
import { runApproval } from "./approval-command.ts";
import { runAttempt } from "./attempt-command.ts";
import { runCleanup } from "./cleanup-command.ts";
import { runCrewOwn } from "./crew-command.ts";
import { runCrewNext } from "./next-command.ts";
import { runInstall } from "./install-command.ts";
import { runUpdate } from "./update-command.ts";
import { runQuestion } from "./question-command.ts";
import { runReview } from "./review-command.ts";
import { runSetup } from "./setup-command.ts";
import { runTracker } from "./tracker-command.ts";
import { exitCodeByOutcome, type Handled, writeJsonResult } from "./result.ts";
import { usage } from "./usage.ts";
import { runWork } from "./work-command.ts";

type CrewCommand = (words: string[], parsed: ParsedArguments) => Promise<Handled>;

// The commands that read crew state. Each one names its own operations in its own module.
const crewCommands: Record<string, CrewCommand | undefined> = {
  crew: async (words, parsed) => {
    if (words.length !== 1) {
      return "invalid-arguments";
    }
    if (words[0] === "own") {
      return runCrewOwn(parsed);
    }
    return words[0] === "next" ? runCrewNext(parsed) : "invalid-arguments";
  },
  work: runWork,
  attempt: runAttempt,
  question: runQuestion,
  approval: runApproval,
  review: runReview,
  tracker: runTracker,
  cleanup: runCleanup,
};

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
  // The release reports its own version and supported runtime. A registry rewrites the package
  // manifest, so a published copy is never read through it.
  const { version, supportedBun } = await OperatorRelease.manifest();

  // The Bun check runs before any command so an unsupported runtime never writes files.
  if (!Bun.semver.satisfies(Bun.version, supportedBun)) {
    if (args.includes("--json")) {
      writeJsonResult({
        outcome: "failed",
        reason: "unsupported_bun",
        blockers: [
          {
            reason: "unsupported_bun",
            required: supportedBun,
            actual: Bun.version,
          },
        ],
        operation: "startup",
        data: {
          operatorVersion: version,
          bunVersion: Bun.version,
        },
      });
    }
    console.error(`operator: Bun ${supportedBun} is required; running ${Bun.version}.`);
    process.exitCode = exitCodeByOutcome.failed;
    return;
  }

  const [command, ...rest] = args;

  if (command === "update") {
    const { words, parsed } = splitRequest(rest);
    // The update names the release it selects by a full commit, and nothing else about a crew.
    const { baseCommit: _commit, ...otherCrewFlags } = parsed.crew;
    if (
      parsed.unsupported.length > 0 ||
      parsed.approvedPlan !== undefined ||
      parsed.takeover ||
      Object.keys(otherCrewFlags).length > 0 ||
      hasSelectionOrProbeArguments(parsed) ||
      (await runUpdate(words, parsed)) !== "reported"
    ) {
      rejectArguments(parsed.json);
    }
    return;
  }

  if (command === "install") {
    const parsed = parseArguments(rest);
    if (
      parsed.unsupported.length > 0 ||
      parsed.approvedPlan !== undefined ||
      hasCrewArguments(parsed) ||
      hasUpdateArguments(parsed) ||
      hasSelectionOrProbeArguments(parsed)
    ) {
      rejectArguments(parsed.json);
      return;
    }
    await runInstall(parsed);
    return;
  }

  if (command === "setup") {
    const { words, parsed } = splitRequest(rest);
    if (
      parsed.unsupported.length > 0 ||
      hasCrewArguments(parsed) ||
      hasUpdateArguments(parsed) ||
      (await runSetup(words, parsed)) !== "reported"
    ) {
      rejectArguments(parsed.json);
    }
    return;
  }

  const crewCommand = command === undefined ? undefined : crewCommands[command];
  if (crewCommand !== undefined) {
    const { words, parsed } = splitRequest(rest);
    // The next actions answer for one installation and one selection, so only that read
    // carries the target and selection flags every other crew command refuses.
    const selects = command === "crew" && words[0] === "next";
    if (
      parsed.unsupported.length > 0 ||
      (!selects && parsed.targets.length > 0) ||
      parsed.approvedPlan !== undefined ||
      hasUpdateArguments(parsed) ||
      // Only crew ownership can be taken over, so every other command refuses the flag.
      (parsed.takeover && !(command === "crew" && words[0] === "own")) ||
      // A dispatch fixes the selection it launches with, so only it reads a selection override.
      parsed.approvedProbe !== undefined ||
      (!(command === "attempt" && words[0] === "dispatch") &&
        !selects &&
        hasSelectionOrProbeArguments(parsed))
    ) {
      rejectArguments(parsed.json);
      return;
    }

    if ((await crewCommand(words, parsed)) !== "reported") {
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
        operatorVersion: version,
        bunVersion: Bun.version,
      },
    });
    process.exitCode = exitCodeByOutcome.completed;
    return;
  }

  if (args.length === 1 && args[0] === "--version") {
    console.log(`operator ${version}`);
    process.exitCode = exitCodeByOutcome.completed;
    return;
  }

  rejectArguments(args.includes("--json"));
}
