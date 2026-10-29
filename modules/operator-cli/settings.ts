import { DeviceSettings } from "../device-settings/main.ts";
import type { OperatorHome } from "../operator-home/main.ts";
import { respond } from "./output.ts";

type OperatorPaths = ReturnType<typeof OperatorHome.resolve>;

export const settingsExitCodes = {
  host_defect: 1,
  host_unavailable: 3,
  host_metadata_failed: 1,
  unsupported_model: 3,
  unsupported_effort: 3,
  profile_missing: 3,
  selection_incomplete: 3,
  invalid_settings: 2,
  invalid_settings_edit: 2,
  settings_io_failed: 1,
  settings_recovery_required: 3,
  settings_plan_required: 3,
  settings_plan_stale: 4,
  settings_external: 3,
  settings_write_unconfirmed: 5,
};

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
  respond({
    operation: `config_${settings.command}`,
    result,
    exitCodes: settingsExitCodes,
    defect: "settings_defect",
    json,
  });
  return true;
}
