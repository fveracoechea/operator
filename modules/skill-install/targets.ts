export const skillTargets = {
  opencode: ".agents/skills",
  "claude-code": ".claude/skills",
} as const;

export type SkillTarget = keyof typeof skillTargets;
