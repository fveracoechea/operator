import { AgentHosts } from "../agent-hosts/main.ts";
import { DeviceSettings } from "../device-settings/main.ts";
import type { OperatorHome } from "../operator-home/main.ts";
import { z } from "zod";
import { respond } from "./output.ts";
import { settingsExitCodes } from "./settings.ts";

const flagsSchema = z.strictObject({
  host: z.enum(["opencode", "claude-code"]).optional(),
  role: z.enum(["superAgent", "workerAgent"]).optional(),
  profile: z.string().optional(),
  model: z.string().min(1).optional(),
  effort: z.string().min(1).optional(),
});

function parse(args: string[]) {
  const [group, command, ...flags] = args;
  if (
    !((group === "host" && command === "models") || (group === "config" && command === "resolve"))
  )
    return null;
  const parsed = flagsSchema.safeParse(readFlags(flags));
  if (!parsed.success) return null;
  if (group === "host") {
    const { host, ...others } = parsed.data;
    return host === undefined || Object.keys(others).length > 0 ? null : { host };
  }
  return { launch: parsed.data };
}

function overridesOf(flags: z.infer<typeof flagsSchema>) {
  const overrides: Parameters<typeof DeviceSettings.resolve>[0]["overrides"] = {};
  if (flags.host !== undefined) overrides.host = flags.host;
  if (flags.model !== undefined) overrides.model = flags.model;
  if (flags.effort !== undefined) overrides.reasoningEffort = flags.effort;
  return overrides;
}

function readFlags(flags: string[]) {
  const values: Record<string, string> = {};
  const seen = new Set<string>();
  const rest = flags.values();
  for (const key of rest) {
    if (seen.has(key)) return null;
    seen.add(key);
    if (key === "--json") continue;
    const value = rest.next().value;
    if (!key.startsWith("--") || value === undefined || value.startsWith("--")) return null;
    values[key.slice(2)] = value;
  }
  return values;
}

export async function runProfiles(
  args: string[],
  paths: ReturnType<typeof OperatorHome.resolve>,
  json: boolean,
) {
  const parsed = parse(args);
  if (parsed === null) return false;
  const result = await (parsed.launch !== undefined
    ? DeviceSettings.resolve({
        paths,
        cwd: process.cwd(),
        role: parsed.launch.role,
        profile: parsed.launch.profile,
        overrides: overridesOf(parsed.launch),
      })
    : AgentHosts.models({ host: parsed.host, cwd: process.cwd() }));
  const operation = parsed.launch === undefined ? "host_models" : "config_resolve";
  respond({
    operation,
    result: result.map((data) => ({
      reason: parsed.launch === undefined ? "host_models_read" : "launch_resolved",
      data,
    })),
    exitCodes: settingsExitCodes,
    defect: parsed.launch === undefined ? "host_defect" : "settings_defect",
    json,
  });
  return true;
}
