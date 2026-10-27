// Bun has no realpath or path API.
import { realpath } from "node:fs/promises";
import path from "node:path";
import { ToolInvocation } from "../tool-invocation/main.ts";

type Outcome = { state: "removed" | "absent" | "kept"; detail: string };

async function git(cwd: string, args: string[]) {
  const result = await ToolInvocation.run({
    tool: "git",
    args: ["-C", cwd, ...args],
    timeoutMs: 60000,
  });
  if (result.status !== "completed" || result.exitCode !== 0)
    // oxlint-disable-next-line unthrown/no-throw -- The caller records any Git failure as a failed cleanup.
    throw new Error(
      `git ${args.slice(0, 2).join(" ")} failed: ${result.status === "completed" ? result.stderr.trim() : result.detail}`,
    );
  return result.stdout;
}

async function branchExists(cwd: string, branch: string | null) {
  if (branch === null) return false;
  const result = await ToolInvocation.run({
    tool: "git",
    args: ["-C", cwd, "show-ref", "--verify", "--quiet", `refs/heads/${branch}`],
    timeoutMs: 60000,
  });
  if (result.status !== "completed" || result.exitCode > 1)
    // oxlint-disable-next-line unthrown/no-throw -- The caller records any Git failure as a failed cleanup.
    throw new Error(`git show-ref failed for ${branch}.`);
  return result.exitCode === 0;
}

/** A prepared project input is a dependency folder or an environment file equal to the checkout's. */
async function preparedInput(checkout: string, worktree: string, entry: string) {
  if (entry.split("/").includes("node_modules")) return true;
  const name = path.basename(entry);
  if (!/^\.env(?:\.[^/]+)?\.local$/.test(name)) return false;
  const original = Bun.file(path.join(checkout, entry));
  if (!(await original.exists())) return false;
  const copy = await Bun.file(path.join(worktree, entry)).bytes();
  return Buffer.compare(copy, await original.bytes()) === 0;
}

/** Each reason names work that only the person can authorize to delete. */
async function unlanded(checkout: string, worktree: string, branch: string | null) {
  const status = (await git(worktree, ["status", "--porcelain", "-z", "--ignored=matching"]))
    .split("\0")
    .filter((line) => line !== "");
  const reasons: string[] = [];
  for (const line of status) {
    const entry = line.slice(3).replace(/\/$/, "");
    if (!line.startsWith("!! ")) reasons.push(`changed or untracked ${entry}`);
    else if (!(await preparedInput(checkout, worktree, entry))) reasons.push(`ignored ${entry}`);
  }
  // Git matches a pattern before --branches without the refs/heads/ prefix.
  const exclude = branch === null ? [] : [`--exclude=${branch}`];
  // HEAD can leave the recorded branch, so the branch tip is inspected as well.
  const tips = (await branchExists(worktree, branch)) ? ["HEAD", `refs/heads/${branch}`] : ["HEAD"];
  const commits = await git(worktree, [
    "rev-list",
    "--max-count=1",
    ...tips,
    "--not",
    ...exclude,
    "--branches",
    "--remotes",
  ]);
  if (commits.trim() !== "") reasons.push("commits that no other branch or remote branch holds");
  return reasons;
}

/**
 * Keep a report worktree unless Git establishes that it holds no unlanded work. Removal uses
 * the non-forcing Git command, so Git also refuses a worktree that changed after inspection.
 */
export async function cleanWorktree(input: {
  checkout: string;
  worktree: string;
  branch: string | null;
}): Promise<Outcome> {
  const worktree = await realpath(input.worktree).catch(() => null);
  if (worktree === null)
    return { state: "absent", detail: `Worktree ${input.worktree} no longer exists.` };
  const reasons = await unlanded(input.checkout, worktree, input.branch);
  if (reasons.length > 0)
    return {
      state: "kept",
      detail: `Kept worktree ${worktree}, because it holds ${reasons.join(", ")}. Only the person can authorize its deletion.`,
    };
  await git(input.checkout, ["worktree", "remove", worktree]);
  if (input.branch !== null) await git(input.checkout, ["branch", "-D", input.branch]);
  return {
    state: "removed",
    detail: `Removed worktree ${worktree}${input.branch === null ? "" : ` and its branch ${input.branch}, whose commits other branches hold`}.`,
  };
}
