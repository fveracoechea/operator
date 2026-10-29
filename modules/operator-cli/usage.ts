type Release = { version: string; commit: string | null; artifactIdentity: string | null };

const usage =
  "Usage: operator --help | --version [--json]\n       operator config show | recover [--json]\n       operator config plan | apply (--set field=value | --unset field)... [--plan id] [--json]\n       operator host models --host opencode|claude-code [--json]\n       operator config resolve [--role superAgent|workerAgent] [--profile name] [--host host] [--model model] [--effort effort] [--json]\n       operator project register [--repository owner/repository] [--json]\n       operator project show | list [--json]\n       operator project move [--repository owner/repository] [--json]\n       operator project remove owner/repository --person-instructed [--json]\n       operator install --opencode | --claude | --opencode --claude [--check] [--json]\n       operator install matt --opencode | --claude | --opencode --claude [--json]\n       operator install launcher [--json]\n       operator ready [--json]\n       operator source register --file path [--json]\n       operator source show --source id [--json]\n       operator source reset --source id --person-instructed [--json]\n       operator source prune [--json]\n       operator next [--source id] [--json]\n       operator dispatch --source id --assignment key [--json]\n       operator herdr install [--json]\n       operator herdr event [--json]\n       operator pr associate [--json]\n       operator pr wait [--timeout seconds] [--json]\n       operator report submit --file path [--json]\n       operator report resume [--json]\n       operator report accept --source id --assignment key [--json]\n       operator report return --source id --assignment key --file path [--json]\n       operator pr merge [--json]\n       operator cleanup --source id --assignment key [--person-instructed] [--json]\n       operator review add | post | skip | cleanup <pr-url> [--json]\n       operator review start <pr-url> [--profile name] [--json]\n       operator review next [--json]\n       operator review wait [--timeout seconds] [--slack] [--json]\n       operator review ingest --input path|- [--json]\n       operator review slack-done <effect-id> --input path|- [--json]";

/** Answers help and version requests. Returns false for any other arguments. */
export function runUsage(args: string[], release: Release, json: boolean) {
  if (args.length === 1 && args[0] === "--help") {
    console.log(usage);
    process.exitCode = 0;
    return true;
  }
  const version =
    (args.length === 1 && args[0] === "--version") ||
    (args.length === 2 && json && args.includes("--version"));
  if (!version) return false;
  const { version: operatorVersion, commit, artifactIdentity } = release;
  console.log(
    json
      ? JSON.stringify({
          schemaVersion: 1,
          operation: "version",
          outcome: "completed",
          reason: "version_reported",
          blockers: [],
          data: { operatorVersion, bunVersion: Bun.version, commit, artifactIdentity },
        })
      : `operator ${operatorVersion}`,
  );
  process.exitCode = 0;
  return true;
}

/** Reports arguments that no command accepts. */
export function invalidArguments(json: boolean) {
  if (json)
    console.log(
      JSON.stringify({
        schemaVersion: 1,
        operation: "parse_arguments",
        outcome: "invalid",
        reason: "invalid_arguments",
        blockers: [{ reason: "invalid_arguments" }],
      }),
    );
  console.error(usage);
  process.exitCode = 2;
}
