import { OperatorRelease } from "../operator-release/main.ts";
import { Environment } from "../environment/main.ts";
import { OperatorHome } from "../operator-home/main.ts";
import { DeviceSettings } from "../device-settings/main.ts";
import { Projects } from "../projects/main.ts";
import { DeviceState } from "../device-state/main.ts";
import { fromThrowable } from "unthrown";
import { z } from "zod";
import { runProfiles } from "./profiles.ts";
import { runSkills } from "./skills.ts";
import { runLauncher } from "./launcher.ts";
import { runReadiness } from "./readiness.ts";
import { runSources } from "./sources.ts";
import { herdrEventWithoutState, runDispatch } from "./dispatch.ts";
import { runPullRequests } from "./pull-requests.ts";
import { runReports } from "./reports.ts";
import { runReviews } from "./reviews.ts";
import { failure, settingsExitCodes } from "./output.ts";

type OperatorPaths = ReturnType<typeof OperatorHome.resolve>;

const usage =
  "Usage: operator --help | --version [--json]\n       operator config show | recover [--json]\n       operator config plan | apply (--set field=value | --unset field)... [--plan id] [--json]\n       operator host models --host opencode|claude-code [--json]\n       operator config resolve [--role superAgent|workerAgent] [--profile name] [--host host] [--model model] [--effort effort] [--json]\n       operator project register [--repository owner/repository] [--json]\n       operator project show | list [--json]\n       operator project move [--repository owner/repository] [--json]\n       operator project remove owner/repository --person-instructed [--json]\n       operator install --opencode | --claude | --opencode --claude [--check] [--json]\n       operator install matt --opencode | --claude | --opencode --claude [--json]\n       operator install launcher [--json]\n       operator ready [--json]\n       operator source register --file path [--json]\n       operator source show --source id [--json]\n       operator source reset --source id --person-instructed [--json]\n       operator source prune [--json]\n       operator next [--source id] [--json]\n       operator dispatch --source id --assignment key [--json]\n       operator herdr install [--json]\n       operator herdr event [--json]\n       operator pr associate [--json]\n       operator pr wait [--timeout seconds] [--json]\n       operator report submit --file path [--json]\n       operator report resume [--json]\n       operator report accept --source id --assignment key [--json]\n       operator report return --source id --assignment key --file path [--json]\n       operator pr merge [--json]\n       operator cleanup --source id --assignment key [--person-instructed] [--json]\n       operator review add | post | skip | cleanup <pr-url> [--json]\n       operator review start <pr-url> [--profile name] [--json]\n       operator review next [--json]\n       operator review wait [--timeout seconds] [--json]";

const projectExitCodes = {
  repository_choice_invalid: 2,
  repository_choice_required: 3,
  github_remote_missing: 3,
  git_unavailable: 3,
  git_checkout_invalid: 3,
  bare_repository: 3,
  linked_checkout: 3,
  legacy_project_state: 3,
  state_missing: 3,
  state_busy: 1,
  state_io_failed: 1,
  state_corrupt: 3,
  state_incompatible: 3,
  state_backup_failed: 1,
  state_migration_blocked: 3,
  controller_mismatch: 4,
  controller_identity_mismatch: 4,
  project_not_registered: 3,
  project_io_failed: 1,
  project_source_open: 3,
  project_cleanup_open: 3,
  project_cleanup_pending: 1,
  person_instruction_required: 3,
};

function projectArgs(args: string[]) {
  const [group, command, ...flags] = args;
  if (
    group !== "project" ||
    !["register", "show", "list", "move", "remove"].includes(command ?? "")
  )
    return null;
  const identity = command === "remove" ? flags.shift() : undefined;
  if (command === "remove" && (!identity || identity.startsWith("--"))) return null;
  const parsed = projectFlags(flags, command ?? "");
  if (parsed === null) return null;
  return {
    command,
    repository: identity ?? parsed.repository,
    personInstructed: parsed.personInstructed,
  };
}

function projectFlags(flags: string[], command: string) {
  let repository: string | undefined;
  let personInstructed = false;
  const seen = new Set<string>();
  for (let index = 0; index < flags.length; index++) {
    const flag = flags[index];
    if (flag === undefined || seen.has(flag)) return null;
    seen.add(flag);
    if (flag === "--json") continue;
    if (flag === "--person-instructed" && command === "remove") personInstructed = true;
    else if (flag === "--repository" && ["register", "move"].includes(command)) {
      repository = flags[++index];
      if (repository === undefined || repository.startsWith("--")) return null;
    } else return null;
  }
  return { repository, personInstructed };
}

async function runProject(args: string[], paths: OperatorPaths, json: boolean) {
  const project = projectArgs(args);
  if (project === null) return false;
  const input = { paths, cwd: process.cwd(), repository: project.repository };
  const result = await (project.command === "list"
    ? Projects.list(paths)
    : project.command === "remove"
      ? Projects.remove({
          paths,
          repository: project.repository ?? "",
          personInstructed: project.personInstructed,
        })
      : project.command === "move"
        ? Projects.move(input)
        : project.command === "register"
          ? Projects.register(input)
          : Projects.current(input));
  const operation = `project_${project.command}`;
  if (result.tag === "Ok") {
    console.log(
      JSON.stringify(
        {
          schemaVersion: 1,
          operation,
          outcome: "completed",
          reason: result.value.reason,
          blockers: [],
          data: result.value.data,
        },
        null,
        json ? undefined : 2,
      ),
    );
    process.exitCode = 0;
  } else if (result.tag === "Err")
    failure(
      operation,
      result.error.reason,
      result.error.detail,
      projectExitCodes[result.error.reason],
      json,
    );
  else failure(operation, "project_defect", String(result.cause), 1, json);
  return true;
}

function settingsArgs(args: string[]) {
  const [group, command, ...flags] = args;
  if (group !== "config" || !["show", "plan", "apply", "recover"].includes(command ?? ""))
    return null;
  const parsed = settingsFlags(flags);
  if (parsed === null) return null;
  if (
    (command === "show" || command === "recover") &&
    parsed.sets.length + parsed.unsets.length > 0
  )
    return null;
  if (command !== "apply" && parsed.planId !== undefined) return null;
  return { command, ...parsed };
}

function settingsFlags(flags: string[]) {
  const sets: string[] = [];
  const unsets: string[] = [];
  let planId: string | undefined;
  const seen = new Set<string>();
  for (let index = 0; index < flags.length; index++) {
    const flag = flags[index];
    if (flag === "--json" && !seen.has(flag)) {
      seen.add(flag);
      continue;
    }
    const value = flags[++index];
    if (value === undefined || value.startsWith("--")) return null;
    if (flag === "--set") sets.push(value);
    else if (flag === "--unset") unsets.push(value);
    else if (flag === "--plan" && planId === undefined) planId = value;
    else return null;
  }
  return { sets, unsets, planId };
}

async function runSettings(args: string[], paths: OperatorPaths, json: boolean) {
  const settings = settingsArgs(args);
  if (settings === null) return false;
  const request = { ...settings, paths, cwd: process.cwd() };
  const result = await (settings.command === "show"
    ? DeviceSettings.show(paths)
    : settings.command === "recover"
      ? DeviceSettings.recover(paths)
      : settings.command === "plan"
        ? DeviceSettings.plan(request)
        : DeviceSettings.apply(request));
  if (result.tag === "Ok") {
    console.log(
      JSON.stringify(
        {
          schemaVersion: 1,
          operation: `config_${settings.command}`,
          outcome: "completed",
          reason: result.value.reason,
          blockers: [],
          data: result.value.data,
        },
        null,
        json ? undefined : 2,
      ),
    );
    process.exitCode = 0;
  } else if (result.tag === "Err") {
    failure(
      `config_${settings.command}`,
      result.error.reason,
      result.error.detail,
      settingsExitCodes[result.error.reason],
      json,
    );
  } else {
    failure(`config_${settings.command}`, "settings_defect", String(result.cause), 1, json);
  }
  return true;
}

function startupPaths(json: boolean) {
  const startup = fromThrowable(
    () => OperatorHome.resolve(Environment.read()),
    (cause, defect) => (cause instanceof z.ZodError ? cause.message : defect(cause)),
  )();
  if (startup.tag !== "Ok") {
    failure(
      "startup",
      startup.tag === "Err" ? "invalid_environment" : "startup_defect",
      startup.tag === "Err" ? startup.error : String(startup.cause),
      startup.tag === "Err" ? 2 : 1,
      json,
    );
    return null;
  }
  return startup.value;
}

function versionArgs(args: string[], json: boolean) {
  return (
    (args.length === 1 && args[0] === "--version") ||
    (args.length === 2 && json && args.includes("--version"))
  );
}

/** Startup checks state compatibility before every command that reads device state. */
async function compatibleState(args: string[], paths: OperatorPaths, json: boolean) {
  if (await herdrEventWithoutState(args, paths, json)) return false;
  const compatible = DeviceState.checkCompatibility(
    paths,
    projectArgs(args)?.command === "register",
  );
  if (compatible.tag !== "Ok") {
    if (compatible.tag === "Err")
      failure(
        "startup",
        compatible.error.reason,
        compatible.error.detail,
        projectExitCodes[compatible.error.reason],
        json,
      );
    else failure("startup", "startup_defect", String(compatible.cause), 1, json);
    return false;
  }
  return true;
}

export async function run(args: string[]): Promise<void> {
  const json = args.includes("--json");
  const paths = startupPaths(json);
  if (paths === null) return;
  const { version, supportedBun, commit, artifactIdentity } = await OperatorRelease.manifest();
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

  if (!(await compatibleState(args, paths, json))) return;

  if (args.length === 1 && args[0] === "--help") {
    console.log(usage);
    process.exitCode = 0;
    return;
  }
  if (versionArgs(args, json)) {
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

  for (const handler of [
    async (input: string[], _paths: OperatorPaths, flag: boolean) => runLauncher(input, flag),
    runSkills,
    runReadiness,
    runProfiles,
    runSettings,
    runProject,
    runSources,
    runDispatch,
    runPullRequests,
    runReports,
    runReviews,
  ]) {
    if (await handler(args, paths, json)) return;
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
