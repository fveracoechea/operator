type Release = { version: string; commit: string | null; artifactIdentity: string | null };

const usage = `Usage: operator --help | --version [--json]
       operator config show | recover [--json]
       operator config plan | apply (--set field=value | --unset field)... [--plan id] [--json]
       operator host models --host opencode|claude-code [--json]
       operator config resolve [--role superAgent|workerAgent] [--profile name] [--host host] [--model model] [--effort effort] [--json]
       operator project register [--repository owner/repository] [--json]
       operator project show | list [--json]
       operator project move [--repository owner/repository] [--json]
       operator project remove owner/repository --person-instructed [--json]
       operator install --opencode | --claude | --opencode --claude [--check] [--json]
       operator install launcher [--json]
       operator ready [--json]
       operator source register --file path [--json]
       operator source show --source id [--json]
       operator source reset --source id --person-instructed [--json]
       operator source take-over --source id --person-instructed [--json]
       operator source prune [--json]
       operator next [--source id] [--wait [--timeout seconds]] [--all] [--json]
       operator dispatch --source id --assignment key [--json]
       operator ask --question text [--profile name] [--json]
       operator herdr install [--json]
       operator herdr event [--json]
       operator pr associate [--json]
       operator pr wait [--timeout seconds] [--json]
       operator pr round --file path [--json]
       operator pr ready --file path [--json]
       operator report submit --file path [--json]
       operator report resume [--json]
       operator report accept --source id --assignment key [--promote path] [--json]
       operator report return --source id --assignment key --file path [--json]
       operator question ask --file path [--json]
       operator question wait --key key [--timeout seconds] [--json]
       operator question withdraw --key key [--json]
       operator question escalate --source id --assignment key --key key [--json]
       operator question answer --source id --assignment key --key key --by super-agent|person (--file path | --text text) [--json]
       operator message send --source id --assignment key (--file path | --key key --text text) [--json]
       operator message ring | close --source id --assignment key --key key [--json]
       operator message read --key key [--json]
       operator message ack --key key [--file path] [--json]
       operator obligation add --source id --file path [--json]
       operator obligation close --source id --key key [--json]
       operator obligation list --source id [--json]
       operator pr merge [--json]
       operator cleanup --source id --assignment key [--person-instructed] [--json]
       operator handoff --source id --assignment key [--json]
       operator internal-review skip --source id --assignment key --person-instructed [--json]
       operator review add <pr-url> [--slack-thread permalink] [--json]
       operator review post | skip | cleanup <pr-url> [--json]
       operator review start <pr-url> [--profile name] [--json]
       operator review next [--json]
       operator review wait [--timeout seconds] [--all] [--json]
       operator claude hook
       operator opencode hook`;

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
