import { OperatorRelease } from "../operator-release/main.ts";

const usage = "Usage: operator --help | --version [--json]";

export async function run(args: string[]): Promise<void> {
  const { version, supportedBun, commit, artifactIdentity } = await OperatorRelease.manifest();
  const json = args.includes("--json");
  if (!Bun.semver.satisfies(Bun.version, supportedBun)) {
    if (json) {
      console.log(
        JSON.stringify({
          schemaVersion: 1,
          operation: "startup",
          outcome: "failed",
          reason: "unsupported_bun",
          blockers: [{ reason: "unsupported_bun", required: supportedBun, actual: Bun.version }],
        }),
      );
    }
    console.error(`operator: Bun ${supportedBun} is required; running ${Bun.version}.`);
    process.exitCode = 1;
    return;
  }

  if (args.length === 1 && args[0] === "--help") {
    console.log(usage);
    process.exitCode = 0;
    return;
  }
  if (
    (args.length === 1 && args[0] === "--version") ||
    (args.length === 2 && json && args.includes("--version"))
  ) {
    console.log(
      json
        ? JSON.stringify({
            schemaVersion: 1,
            operation: "version",
            outcome: "completed",
            reason: "version_reported",
            blockers: [],
            data: { operatorVersion: version, bunVersion: Bun.version, commit, artifactIdentity },
          })
        : `operator ${version}`,
    );
    process.exitCode = 0;
    return;
  }

  if (json) {
    console.log(
      JSON.stringify({
        schemaVersion: 1,
        operation: "parse_arguments",
        outcome: "invalid",
        reason: "invalid_arguments",
        blockers: [{ reason: "invalid_arguments" }],
      }),
    );
  }
  console.error(usage);
  process.exitCode = 2;
}
