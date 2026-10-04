import { OperatorRelease } from "../operator-release/main.ts";
import { ReleaseInstall } from "../release-install/main.ts";
import { commandWords, rejectArguments, runOperation } from "./operations.ts";
import { exitCodeByOutcome, refuse, useProjectInvocation, writeJsonResult } from "./result.ts";

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
    commandWords,
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

export async function run(args: string[]): Promise<void> {
  // The release reports its own version and supported runtime. A registry rewrites the package
  // manifest, so a published copy is never read through it.
  const { version, supportedBun } = await OperatorRelease.manifest();

  if (!runtimeSupported(args, version, supportedBun)) return;

  const [command, ...rest] = args;
  if (await releaseMismatch(args, command, rest)) return;
  if (command !== undefined && (await runOperation(command, rest))) return;

  if (reportVersion(args, version)) return;
  rejectArguments(args.includes("--json"));
}
