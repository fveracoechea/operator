import { AgentHosts } from "../agent-hosts/main.ts";
import { selectLaunch } from "./selection.ts";
import type { DeviceConfig } from "./schema.ts";
import type { OperatorHome } from "../operator-home/main.ts";
import { z } from "zod";

export async function validateGuides(
  config: DeviceConfig,
  paths: ReturnType<typeof OperatorHome.resolve>,
) {
  for (const [name, definition] of Object.entries(config.kinds ?? {})) {
    const roots = [
      paths.skillHosts.opencode,
      paths.upstreamSkills.opencode,
      paths.skillHosts["claude-code"],
    ];
    if (
      !(
        await Promise.all(roots.map((root) => Bun.file(`${root}/${definition.guide}`).exists()))
      ).some(Boolean)
    )
      // oxlint-disable-next-line unthrown/no-throw -- The settings boundary qualifies invalid installed-guide references like schema errors.
      throw new z.ZodError([
        {
          code: "custom",
          path: ["kinds", name, "guide"],
          message: `No installed guide skill: ${definition.guide}.`,
        },
      ]);
  }
}

export async function validateSelections(config: DeviceConfig, cwd: string) {
  const requests = [
    { role: "superAgent" as const, model: config.superAgent.model },
    { role: "workerAgent" as const, model: config.workerAgent.model },
    ...Object.entries(config.profiles ?? {}).map(([profile, selection]) => ({
      role: "workerAgent" as const,
      profile,
      model: selection.model,
    })),
  ];
  for (const { model, ...request } of requests) {
    const selected = selectLaunch(config, request);
    if ("reason" in selected) {
      if (model !== undefined) return selected;
      continue;
    }
    const result = await AgentHosts.resolve({ ...selected, cwd });
    if (result.tag === "Err") return result.error;
    if (result.tag === "Defect") {
      // oxlint-disable-next-line unthrown/no-throw -- The settings boundary preserves unexpected host defects rather than converting them to refusals.
      throw result.cause;
    }
  }
  return null;
}
