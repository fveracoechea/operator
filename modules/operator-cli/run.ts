import { OperatorRelease } from "../operator-release/main.ts";
import { ReleaseInstall } from "../release-install/main.ts";
import {
  hasCrewArguments,
  hasConfigArguments,
  hasSelectionOrProbeArguments,
  hasUpdateArguments,
  type ParsedArguments,
  splitRequest,
} from "./arguments.ts";
import { runApproval } from "./approval-command.ts";
import { runAttempt } from "./attempt-command.ts";
import { runCleanup } from "./cleanup-command.ts";
import { runConfig } from "./config-command.ts";
import { runCrewOwn } from "./crew-command.ts";
import { runHealthcheck } from "./healthcheck-command.ts";
import { runGate } from "./gate-command.ts";
import { runCrewNext } from "./next-command.ts";
import { runInstall, runMattSkills } from "./install-command.ts";
import { runUpdate } from "./update-command.ts";
import { runQuestion } from "./question-command.ts";
import { runReview } from "./review-command.ts";
import { runSetup } from "./setup-command.ts";
import { runTracker } from "./tracker-command.ts";
import {
  exitCodeByOutcome,
  type Handled,
  refuse,
  useProjectInvocation,
  writeJsonResult,
} from "./result.ts";
import { usage } from "./usage.ts";
import { runWork } from "./work-command.ts";
import { runWake } from "./wake-command.ts";

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
  gate: runGate,
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

async function runUpdateCommand(rest: string[]): Promise<void> {
  const { words, parsed } = splitRequest(rest);
  // The update names the release it selects by a full commit, and nothing else about a crew.
  const { baseCommit: _commit, ...otherCrewFlags } = parsed.crew;
  if (
    parsed.unsupported.length > 0 ||
    parsed.approvedPlan !== undefined ||
    parsed.takeover ||
    parsed.plan ||
    Object.keys(otherCrewFlags).length > 0 ||
    hasSelectionOrProbeArguments(parsed) ||
    hasConfigArguments(parsed) ||
    (await runUpdate(words, parsed)) !== "reported"
  )
    rejectArguments(parsed.json);
}

async function runInstallCommand(rest: string[]): Promise<void> {
  const { words, parsed } = splitRequest(rest);
  if (words[0] === "matt") {
    const { baseCommit: _commit, ...otherCrewFlags } = parsed.crew;
    if (
      parsed.unsupported.length > 0 ||
      Object.keys(otherCrewFlags).length > 0 ||
      parsed.takeover ||
      parsed.plan ||
      hasUpdateArguments(parsed) ||
      hasSelectionOrProbeArguments(parsed) ||
      hasConfigArguments(parsed) ||
      (await runMattSkills(words.slice(1), parsed)) !== "reported"
    )
      rejectArguments(parsed.json);
    return;
  }
  if (
    words.length !== 0 ||
    parsed.unsupported.length > 0 ||
    parsed.approvedPlan !== undefined ||
    hasCrewArguments(parsed) ||
    hasUpdateArguments(parsed) ||
    hasSelectionOrProbeArguments(parsed) ||
    hasConfigArguments(parsed)
  ) {
    rejectArguments(parsed.json);
    return;
  }
  await runInstall(parsed);
}

async function runSetupCommand(rest: string[]): Promise<void> {
  const { words, parsed } = splitRequest(rest);
  if (
    parsed.unsupported.length > 0 ||
    hasCrewArguments(parsed) ||
    hasConfigArguments(parsed) ||
    hasUpdateArguments(parsed) ||
    (await runSetup(words, parsed)) !== "reported"
  )
    rejectArguments(parsed.json);
}

async function runConfigCommand(rest: string[]): Promise<void> {
  const { words, parsed } = splitRequest(rest);
  if (
    parsed.unsupported.length > 0 ||
    parsed.targets.length > 0 ||
    parsed.takeover ||
    hasCrewArguments(parsed) ||
    hasSelectionOrProbeArguments(parsed) ||
    hasUpdateArguments(parsed) ||
    (await runConfig(words, parsed)) !== "reported"
  )
    rejectArguments(parsed.json);
}

async function runHealthcheckCommand(rest: string[]): Promise<void> {
  const { words, parsed } = splitRequest(rest);
  if (
    words.length > 0 ||
    parsed.unsupported.length > 0 ||
    hasCrewArguments(parsed) ||
    hasConfigArguments(parsed) ||
    hasUpdateArguments(parsed) ||
    parsed.approvedPlan !== undefined ||
    parsed.approvedProbe !== undefined ||
    parsed.approvedCleanup !== undefined ||
    parsed.staleOnly
  ) {
    rejectArguments(parsed.json);
    return;
  }
  await runHealthcheck(parsed);
}

function runtimeSupported(args: string[], version: string, supportedBun: string): boolean {
  // The Bun check runs before any command so an unsupported runtime never writes files.
  if (Bun.semver.satisfies(Bun.version, supportedBun)) return true;
  if (args.includes("--json")) {
    writeJsonResult({
      outcome: "failed",
      reason: "unsupported_bun",
      blockers: [{ reason: "unsupported_bun", required: supportedBun, actual: Bun.version }],
      operation: "startup",
      data: { operatorVersion: version, bunVersion: Bun.version },
    });
  }
  console.error(`operator: Bun ${supportedBun} is required; running ${Bun.version}.`);
  process.exitCode = exitCodeByOutcome.failed;
  return false;
}

function reportVersion(args: string[], version: string): boolean {
  if (args.length === 2 && args.includes("--version") && args.includes("--json")) {
    writeJsonResult({
      outcome: "completed",
      reason: "version_reported",
      blockers: [],
      operation: "version",
      data: { operatorVersion: version, bunVersion: Bun.version },
    });
    process.exitCode = exitCodeByOutcome.completed;
    return true;
  }
  if (args.length === 1 && args[0] === "--version") {
    console.log(`operator ${version}`);
    process.exitCode = exitCodeByOutcome.completed;
    return true;
  }
  return false;
}

/** Stops commands that cannot safely use a different selected release. */
async function releaseMismatch(
  args: string[],
  command: string | undefined,
  rest: string[],
): Promise<boolean> {
  const selected = await ReleaseInstall.selection({ projectRoot: process.cwd() });
  useProjectInvocation(
    selected.state === "read" ? selected.selection.delivery : null,
    selected.state === "read" ? selected.selection.commit : null,
  );
  if (
    command === "update" ||
    command === "install" ||
    (command === "setup" && rest[0] === "readiness") ||
    args.includes("--version") ||
    selected.state !== "read"
  )
    return false;

  const running = await OperatorRelease.identify();
  if (
    selected.selection.releaseIdentity === running.identity &&
    (running.commit === null || selected.selection.commit === running.commit)
  )
    return false;

  refuse({
    json: args.includes("--json"),
    operation: "startup",
    outcome: "conflict",
    reason: "release_mismatch",
    detail: { selectedVersion: selected.selection.version, runningVersion: running.version },
    lines: [
      `This project selected Operator ${selected.selection.version} at ${selected.selection.commit}, but this CLI runs ${running.version}.`,
      selected.selection.delivery === "jsr"
        ? "Run the selected release with `bun run operator <operation>` from the project root."
        : `Run the selected source release at commit ${selected.selection.commit}.`,
    ],
  });
  return true;
}

/** True when a crew command carries a flag that only another command reads. */
function refusesCrewFlags(
  command: string | undefined,
  words: string[],
  parsed: ParsedArguments,
): boolean {
  // The next actions answer for one installation and one selection, so only that read
  // carries the target and selection flags every other crew command refuses.
  const selects = command === "crew" && words[0] === "next";
  return (
    parsed.unsupported.length > 0 ||
    (!selects && parsed.targets.length > 0) ||
    parsed.approvedPlan !== undefined ||
    hasUpdateArguments(parsed) ||
    hasConfigArguments(parsed) ||
    // Only crew ownership can be taken over, so every other command refuses the flag.
    (parsed.takeover && !(command === "crew" && words[0] === "own")) ||
    // Only a registration has a preview.
    (parsed.plan && !(command === "work" && words[0] === "register")) ||
    // A dispatch fixes the selection it launches with, so only it reads a selection override.
    parsed.approvedProbe !== undefined ||
    (!(command === "attempt" && words[0] === "dispatch") &&
      !selects &&
      hasSelectionOrProbeArguments(parsed))
  );
}

export async function run(args: string[]): Promise<void> {
  // The release reports its own version and supported runtime. A registry rewrites the package
  // manifest, so a published copy is never read through it.
  const { version, supportedBun } = await OperatorRelease.manifest();

  if (!runtimeSupported(args, version, supportedBun)) return;

  const [command, ...rest] = args;
  if (await releaseMismatch(args, command, rest)) return;

  if (command === "wake") {
    if ((await runWake(rest)) !== "reported") rejectArguments(rest.includes("--json"));
    return;
  }

  if (command === "update") {
    await runUpdateCommand(rest);
    return;
  }

  if (command === "install") {
    await runInstallCommand(rest);
    return;
  }

  if (command === "setup") {
    await runSetupCommand(rest);
    return;
  }

  if (command === "config") {
    await runConfigCommand(rest);
    return;
  }

  if (command === "healthcheck") {
    await runHealthcheckCommand(rest);
    return;
  }

  const crewCommand = command === undefined ? undefined : crewCommands[command];
  if (crewCommand !== undefined) {
    const { words, parsed } = splitRequest(rest);
    if (refusesCrewFlags(command, words, parsed)) {
      rejectArguments(parsed.json);
      return;
    }

    if ((await crewCommand(words, parsed)) !== "reported") {
      rejectArguments(parsed.json);
    }
    return;
  }

  if (reportVersion(args, version)) return;
  rejectArguments(args.includes("--json"));
}
