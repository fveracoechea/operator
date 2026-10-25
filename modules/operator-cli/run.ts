import { OperatorRelease } from "../operator-release/main.ts";
import { Environment } from "../environment/main.ts";
import { OperatorHome } from "../operator-home/main.ts";
import { DeviceSettings } from "../device-settings/main.ts";
import { fromThrowable } from "unthrown";
import { z } from "zod";

type OperatorPaths = ReturnType<typeof OperatorHome.resolve>;

const usage =
  "Usage: operator --help | --version [--json]\n       operator config show | recover [--json]\n       operator config plan | apply (--set field=value | --unset field)... [--plan id] [--json]";

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

function failure(operation: string, reason: string, detail: string, code: number, json: boolean) {
  if (json)
    console.log(
      JSON.stringify({
        schemaVersion: 1,
        operation,
        outcome: code === 2 ? "invalid" : "refused",
        reason,
        blockers: [{ reason, detail }],
      }),
    );
  console.error(`operator: ${detail}`);
  process.exitCode = code;
}

async function runSettings(args: string[], paths: OperatorPaths, json: boolean) {
  const settings = settingsArgs(args);
  if (settings === null) return false;
  const request = { ...settings, paths };
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
      result.error.exitCode,
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

  if (await runSettings(args, paths, json)) return;

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
