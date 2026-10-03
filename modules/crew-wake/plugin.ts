import { z } from "zod";
import { ToolInvocation } from "../tool-invocation/main.ts";

const LINK =
  'Run `herdr plugin link "$(operator wake plugin-path)"` and `herdr plugin enable operator.wake`, then check again. Unlink an earlier copy first.';

/** Herdr may add fields, and a field it leaves out reads as the value that fails the check. */
const pluginListSchema = z.object({
  result: z.object({
    plugins: z.array(
      z.object({
        plugin_id: z.string(),
        manifest_path: z.string().nullable().catch(null),
        min_herdr_version: z.string().nullable().catch(null),
        enabled: z.boolean().catch(false),
        warnings: z.array(z.unknown()).catch([]),
      }),
    ),
  }),
});

type Plugin = z.infer<typeof pluginListSchema>["result"]["plugins"][number];

type Health =
  | { state: "passed"; detail: string; nextAction: null }
  | { state: "failed"; detail: string; nextAction: string };

async function readPlugin(): Promise<Plugin | { failed: string }> {
  const invoked = await ToolInvocation.run({
    tool: "herdr",
    args: ["plugin", "list", "--json"],
    timeoutMs: 5_000,
  });
  if (invoked.status !== "completed") return { failed: invoked.detail };
  if (invoked.exitCode !== 0) return { failed: `Herdr plugin list exited ${invoked.exitCode}.` };
  let answer: unknown;
  try {
    answer = JSON.parse(invoked.stdout);
  } catch {
    return { failed: "Herdr plugin list returned invalid JSON." };
  }
  const list = pluginListSchema.safeParse(answer);
  if (!list.success) return { failed: "Herdr plugin list returned an unreadable plugin list." };
  const plugin = list.data.result.plugins.find((one) => one.plugin_id === "operator.wake");
  return plugin ?? { failed: "The Operator wake plugin is not installed." };
}

/** The wake plugin is optional, so its health is advice and never blocks a dispatch. */
export async function pluginHealth(herdrVersion: string): Promise<Health> {
  const plugin = await readPlugin();
  if ("failed" in plugin) return { state: "failed", detail: plugin.failed, nextAction: LINK };

  const expected = new URL("../../herdr/herdr-plugin.toml", import.meta.url).pathname;
  const minimum = plugin.min_herdr_version;
  const compatible = minimum !== null && Bun.semver.satisfies(herdrVersion, `>=${minimum}`);
  const warned = plugin.warnings.length > 0;
  if (plugin.manifest_path === expected && plugin.enabled && compatible && !warned) {
    return {
      state: "passed",
      detail: "The enabled Operator wake plugin matches this CLI release.",
      nextAction: null,
    };
  }
  return {
    state: "failed",
    detail: `The Operator wake plugin is ${plugin.enabled ? "enabled" : "disabled"} at ${plugin.manifest_path ?? "an unknown path"}; expected ${expected}. Herdr ${herdrVersion} must meet the plugin minimum ${minimum ?? "unknown"}.${warned ? " Herdr reports plugin warnings." : ""}`,
    nextAction:
      minimum !== null && !compatible
        ? `Upgrade Herdr to ${minimum} or later, then check again.`
        : LINK,
  };
}
