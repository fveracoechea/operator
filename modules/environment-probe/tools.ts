/** The executable each observed tool installs, which is not always the tool's own name. */
export const toolCommands = {
  bun: "bun",
  git: "git",
  herdr: "herdr",
  github: "gh",
  opencode: "opencode",
  "claude-code": "claude",
} as const;

export type ToolName = keyof typeof toolCommands;

/** Every supported tool answers `--version`, so one reader serves them all. */
export function readVersion(report: string): string | null {
  return /\d+(?:\.\d+)+(?:[-+][0-9A-Za-z.]+)?/.exec(report)?.[0] ?? null;
}
