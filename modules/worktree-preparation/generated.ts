import { approvedEnvFile } from "./env-files.ts";

/**
 * Sorts the ignored entries of a worktree into what preparation wrote and everything else.
 * `git status --ignored=matching` names an ignored folder once, with a trailing slash, or names
 * each child when only the children match a pattern such as `node_modules/*`.
 * A dependency folder counts only beside a tracked manifest when a tracked Bun lockfile made
 * preparation install, and an environment file counts only while it equals the controller's copy.
 * Every other ignored entry is unknown, because it can hold unlanded work.
 */
export function classifyIgnored(input: {
  ignored: string[];
  tracked: Set<string>;
  copiedUnchanged: Set<string>;
}) {
  const installed = input.tracked.has("bun.lock") || input.tracked.has("bun.lockb");
  const generated: string[] = [];
  const unknown: string[] = [];
  for (const entry of input.ignored) {
    // The first dependency folder on the path decides, so nested dependency folders follow it.
    const folder = /^((?:[^/]+\/)*?)node_modules\//.exec(entry)?.[1];
    const dependencies =
      installed && folder !== undefined && input.tracked.has(`${folder}package.json`);
    const environment = approvedEnvFile(entry) && input.copiedUnchanged.has(entry);
    (dependencies || environment ? generated : unknown).push(entry);
  }
  return { generated, unknown };
}
