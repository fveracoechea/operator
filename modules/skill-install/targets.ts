export const skillTargets = {
  opencode: ".agents/skills",
  "claude-code": ".claude/skills",
} as const;

export type SkillTarget = keyof typeof skillTargets;

/** True for a host this release installs skills for. */
export function isSkillTarget(host: string | null): host is SkillTarget {
  return host !== null && Object.hasOwn(skillTargets, host);
}
