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

type Selection = Awaited<ReturnType<typeof ReleaseInstall.selection>>;

/** The selected release as the version command reports it, with the command that runs it. */
function reportedSelection(selection: Selection) {
  if (selection.state !== "selected") return selection;
  const { delivery, version, commit, packageVersion } = selection.selection;
  return {
    state: selection.state,
    delivery,
    version,
    commit,
    packageVersion,
    invocation: ReleaseInstall.invocation(selection.selection),
  };
}

function selectionLines(selection: Selection): string[] {
  const reported = reportedSelection(selection);
  if (reported.state === "missing")
    return ["Selection: missing. This project selected no release."];
  if (reported.state === "unreadable") return [`Selection: unreadable. ${reported.detail}`];
  return [
    "Selection: selected.",
    `  Delivery: ${reported.delivery}`,
    `  Version: ${reported.version}${reported.packageVersion === null ? "" : ` (package ${reported.packageVersion})`}`,
    `  Commit: ${reported.commit}`,
    `  Invocation: ${reported.invocation}`,
  ];
}

function reportVersion(args: string[], version: string, selection: Selection): boolean {
  if (args.length === 2 && args.includes("--version") && args.includes("--json")) {
    writeJsonResult({
      outcome: "completed",
      reason: "version_reported",
      blockers: [],
      operation: "version",
      data: {
        operatorVersion: version,
        bunVersion: Bun.version,
        selection: reportedSelection(selection),
      },
    });
    process.exitCode = exitCodeByOutcome.completed;
    return true;
  }
  if (args.length === 1 && args[0] === "--version") {
    console.log([`operator ${version}`, ...selectionLines(selection)].join("\n"));
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
  selected: Selection,
): Promise<boolean> {
  useProjectInvocation(
    selected.state === "selected" ? selected.selection.delivery : null,
    selected.state === "selected" ? selected.selection.commit : null,
    commandWords,
  );
  if (
    command === "update" ||
    command === "install" ||
    (command === "setup" && rest[0] === "readiness") ||
    args.includes("--version") ||
    selected.state !== "selected"
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
  const selection = await ReleaseInstall.selection({ projectRoot: process.cwd() });
  if (await releaseMismatch(args, command, rest, selection)) return;
  if (command !== undefined && (await runOperation(command, rest))) return;

  if (reportVersion(args, version, selection)) return;
  rejectArguments(args.includes("--json"));
}
