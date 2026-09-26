import { AgentSelection } from "../agent-selection/main.ts";
import { type Observation, toolState } from "./observe.ts";

/**
 * The named inputs a recorded live result is proven against. These names are a durable contract:
 * a rename silently invalidates recorded evidence, so the union makes a rename a compile error.
 */
export type InputName =
  | "platform"
  | "operator-release"
  | "selection"
  | "project-skills"
  | "project-instructions"
  | "tool:git"
  | "tool:herdr"
  | "tool:github";

function sha256(text: string): string {
  return new Bun.CryptoHasher("sha256").update(text).digest("hex");
}

function toolFingerprint(observation: Observation, tool: "git" | "herdr" | "github"): string {
  const observed = toolState(observation, tool);
  return `${observed?.state ?? "missing"}:${observed?.version ?? ""}`;
}

// A live result records what it was proven against, so the reader sees the values, not only a hash.
function selectionFingerprint(observation: Observation): string {
  const roles = (["operator", "crew"] as const).map((role) => {
    const chosen = observation.selection[role];
    return `${role}=${chosen.host.value ?? "unnamed"}/${chosen.model.value ?? "host-default"}`;
  });
  const hostVersions = AgentSelection.requiredHosts(observation.selection).map(
    (host) => `${host}@${toolState(observation, host)?.version ?? "missing"}`,
  );

  return [...roles, ...hostVersions].join(" ");
}

export function fingerprints(observation: Observation): Record<InputName, string> {
  return {
    platform: `${observation.environment.platform}/${observation.environment.architecture}`,
    "operator-release": `${observation.release.version}:${observation.release.identity}:${observation.release.lock.identity ?? "missing"}`,
    selection: selectionFingerprint(observation),
    // Every discoverable copy counts, so narrowing the requested targets changes nothing here.
    "project-skills": sha256(
      JSON.stringify({
        release: observation.release.identity,
        conflicts: observation.everySkillCopy.conflicts,
        missing: observation.everySkillCopy.missing,
      }),
    ),
    "project-instructions": sha256(
      JSON.stringify([observation.instructions.agents, observation.instructions.claude]),
    ),
    "tool:git": toolFingerprint(observation, "git"),
    "tool:herdr": toolFingerprint(observation, "herdr"),
    "tool:github": toolFingerprint(observation, "github"),
  };
}
