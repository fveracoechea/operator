import { AgentSelection } from "../agent-selection/main.ts";
import { ContentIdentity } from "../content-identity/main.ts";
import { SkillInstall } from "../skill-install/main.ts";
import { readConfiguration } from "./observe.ts";
import { identifyRelease } from "./release.ts";

export type LaunchSnapshot = {
  selection: {
    operator: { host: string | null; model: string | null };
    crew: { host: string | null; model: string | null; hostSource: string; modelSource: string };
  };
  release: { version: string; identity: string };
  lock: {
    name: string | null;
    state: "present" | "missing";
    identity: string | null;
    path: string | null;
  };
  skills: { identity: string };
  configuration: { valid: boolean; identity: string | null };
};

/**
 * Reads the launch inputs an attempt fixes before it starts.
 * Recovery compares a recorded snapshot against this reading, so a drifted input is visible
 * instead of being replaced by the current default.
 */
export async function readLaunchSnapshot(request: {
  projectRoot: string;
  overrides: Parameters<typeof AgentSelection.resolve>[0]["overrides"];
}): Promise<LaunchSnapshot> {
  const configuration = await readConfiguration(request.projectRoot);
  const [release, skills] = await Promise.all([identifyRelease(), SkillInstall.identity()]);
  const selection = AgentSelection.resolve({
    overrides: request.overrides,
    configuration: configuration.selection,
  });

  return {
    selection: {
      operator: {
        host: selection.operator.host.value,
        model: selection.operator.model.value,
      },
      crew: {
        host: selection.crew.host.value,
        model: selection.crew.model.value,
        hostSource: selection.crew.host.source,
        modelSource: selection.crew.model.source,
      },
    },
    release: { version: release.version, identity: release.identity },
    lock: release.lock,
    skills: { identity: skills },
    configuration: {
      valid: configuration.valid,
      identity: configuration.text === null ? null : ContentIdentity.ofText(configuration.text),
    },
  };
}
