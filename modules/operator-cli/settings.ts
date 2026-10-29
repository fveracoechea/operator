import { DeviceSettings } from "../device-settings/main.ts";
import type { OperatorHome } from "../operator-home/main.ts";
import { failure, settingsExitCodes } from "./output.ts";

type OperatorPaths = ReturnType<typeof OperatorHome.resolve>;

const settingsCommands = ["show", "plan", "apply", "recover"] as const;

function settingsArgs(args: string[]) {
  const [group, name, ...flags] = args;
  const command = settingsCommands.find((known) => known === name);
  if (group !== "config" || command === undefined) return null;
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
  const rest = flags.values();
  for (const flag of rest) {
    if (flag === "--json" && !seen.has(flag)) {
      seen.add(flag);
      continue;
    }
    const value = rest.next().value;
    if (value === undefined || value.startsWith("--")) return null;
    if (flag === "--set") sets.push(value);
    else if (flag === "--unset") unsets.push(value);
    else if (flag === "--plan" && planId === undefined) planId = value;
    else return null;
  }
  return { sets, unsets, planId };
}

export async function runSettings(args: string[], paths: OperatorPaths, json: boolean) {
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
