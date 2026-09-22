import { AgentSelection } from "../agent-selection/main.ts";
import { EnvironmentProbe } from "../environment-probe/main.ts";
import { ReleaseInstall } from "../release-install/main.ts";
import { OperatorConfig } from "../operator-config/main.ts";
import { ProjectSetup } from "../project-setup/main.ts";
import { SkillInstall } from "../skill-install/main.ts";
import { identifyRelease } from "./release.ts";

export type Target = "opencode" | "claude-code";

export type Overrides = {
  operator?: { host?: Target | undefined; model?: string | undefined } | undefined;
  crew?: { host?: Target | undefined; model?: string | undefined } | undefined;
};

export const CONFIG_PATH = OperatorConfig.configPath();
export const INSTRUCTIONS_PATH = "AGENTS.md";
export const CLAUDE_IMPORT_PATH = "CLAUDE.md";
export const SCHEMA_PATH = OperatorConfig.schemaPath();
export const IGNORE_PATH = ".gitignore";

const observedTools = ["bun", "git", "herdr", "github", "opencode", "claude-code"] as const;

const everyTarget: Target[] = ["claude-code", "opencode"];

async function readTextOrNull(path: string): Promise<string | null> {
  const file = Bun.file(path);
  return (await file.exists()) ? file.text() : null;
}

export async function readConfiguration(projectRoot: string) {
  const text = await readTextOrNull(`${projectRoot}/${CONFIG_PATH}`);
  if (text === null) {
    return { text: null, selection: {}, probe: undefined, valid: false as const };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { text, selection: {}, probe: undefined, valid: false as const };
  }

  const result = OperatorConfig.parse(parsed);
  if (!result.ok) {
    return { text, selection: {}, probe: undefined, valid: false as const };
  }

  return {
    text,
    selection: { operator: result.config.operator, crew: result.config.crew },
    probe: result.config.probe,
    valid: true as const,
  };
}

/** Reads every input a readiness answer depends on, in one pass, and changes nothing. */
export async function observeProject(request: {
  projectRoot: string;
  targets: Target[];
  overrides: Overrides;
}) {
  const configuration = await readConfiguration(request.projectRoot);

  const [environment, plan, skills, everySkillCopy, release, agentsText, claudeText] =
    await Promise.all([
      EnvironmentProbe.observe({ tools: [...observedTools] }),
      ProjectSetup.plan({ projectRoot: request.projectRoot, targets: request.targets }),
      SkillInstall.inspect({ projectRoot: request.projectRoot, targets: request.targets }),
      // Skill evidence follows the copies the project holds, not the targets this request named.
      SkillInstall.inspect({ projectRoot: request.projectRoot, targets: everyTarget }),
      identifyRelease(),
      readTextOrNull(`${request.projectRoot}/${INSTRUCTIONS_PATH}`),
      readTextOrNull(`${request.projectRoot}/${CLAUDE_IMPORT_PATH}`),
    ]);

  // The selected release is compared against the release actually running, so a mismatched or
  // missing installation is reported instead of being replaced by whatever is at hand.
  const installation = await ReleaseInstall.inspect({
    projectRoot: request.projectRoot,
    running: { version: release.version, identity: release.identity, lock: release.lock },
  });

  return {
    targets: request.targets,
    environment,
    plan,
    skills,
    everySkillCopy,
    release,
    installation,
    configuration,
    instructions: { agents: agentsText, claude: claudeText },
    selection: AgentSelection.resolve({
      overrides: request.overrides,
      configuration: configuration.selection,
    }),
  };
}

export type Observation = Awaited<ReturnType<typeof observeProject>>;

export function toolState(observation: Observation, tool: (typeof observedTools)[number]) {
  return observation.environment.tools.find((entry) => entry.tool === tool);
}
