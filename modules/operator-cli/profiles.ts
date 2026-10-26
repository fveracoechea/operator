import { AgentHosts } from "../agent-hosts/main.ts";
import { DeviceSettings } from "../device-settings/main.ts";
import type { OperatorHome } from "../operator-home/main.ts";
import { z } from "zod";

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
  const values = readFlags(flags);
  if (values === null) return null;
  const parsed = flagsSchema.safeParse(values);
  if (!parsed.success) return null;
  if (
    group === "host" &&
    (parsed.data.host === undefined || Object.keys(values).some((key) => key !== "host"))
  )
    return null;
  return { group, ...parsed.data };
}

function readFlags(flags: string[]) {
  const values: Record<string, string> = {};
  const seen = new Set<string>();
  for (let index = 0; index < flags.length; index++) {
    const key = flags[index];
    if (key === undefined || seen.has(key)) return null;
    seen.add(key);
    if (key === "--json") continue;
    const value = flags[++index];
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
  const overrides: Parameters<typeof DeviceSettings.resolve>[0]["overrides"] = {};
  if (parsed.host !== undefined) overrides.host = parsed.host;
  if (parsed.model !== undefined) overrides.model = parsed.model;
  if (parsed.effort !== undefined) overrides.reasoningEffort = parsed.effort;
  const result = await (parsed.group === "host" && parsed.host !== undefined
    ? AgentHosts.models({ host: parsed.host, cwd: process.cwd() })
    : DeviceSettings.resolve({
        paths,
        cwd: process.cwd(),
        role: parsed.role,
        profile: parsed.profile,
        overrides,
      }));
  const operation = parsed.group === "host" ? "host_models" : "config_resolve";
  if (result.tag === "Ok") {
    console.log(
      JSON.stringify(
        {
          schemaVersion: 1,
          operation,
          outcome: "completed",
          reason: parsed.group === "host" ? "host_models_read" : "launch_resolved",
          blockers: [],
          data: result.value,
        },
        null,
        json ? undefined : 2,
      ),
    );
    process.exitCode = 0;
  } else {
    const reason = result.tag === "Err" ? result.error.reason : "host_defect";
    const detail = result.tag === "Err" ? result.error.detail : String(result.cause);
    console.log(
      JSON.stringify({
        schemaVersion: 1,
        operation,
        outcome: "refused",
        reason,
        blockers: [{ reason, detail }],
      }),
    );
    console.error(`operator: ${detail}`);
    process.exitCode = ["host_defect", "host_metadata_failed"].includes(reason) ? 1 : 3;
  }
  return true;
}
