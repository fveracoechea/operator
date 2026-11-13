// Bun has no realpath API.
import { realpath } from "node:fs/promises";
import type { OperatorHome } from "../operator-home/main.ts";
import { ToolInvocation } from "../tool-invocation/main.ts";
import { WorktreePreparation } from "../worktree-preparation/main.ts";

type Outcome = { state: "removed" | "absent" | "kept"; detail: string };

async function git(cwd: string, args: string[]) {
  const result = await ToolInvocation.run({
    tool: "git",
    args: ["-C", cwd, ...args],
    timeoutMs: 60000,
  });
  // Stryker disable next-line ConditionalExpression: equivalent: an invocation that did not complete has no exit code, so the exit check alone refuses it
  if (result.status !== "completed" || result.exitCode !== 0)
    // oxlint-disable-next-line unthrown/no-throw -- The caller records any Git failure as a failed cleanup.
    throw new Error(
      `git ${args.slice(0, 2).join(" ")} failed: ${result.status === "completed" ? result.stderr.trim() : result.detail}`,
    );
  return result.stdout;
}

async function branchExists(cwd: string, branch: string) {
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

/** Each reason names work that only the person can authorize to delete. */
async function unlanded(input: {
  paths: ReturnType<typeof OperatorHome.resolve>;
  checkout: string;
  worktree: string;
  branch: string | null;
}) {
  const { checkout, worktree, branch } = input;
  const status = (await git(worktree, ["status", "--porcelain", "-z", "--ignored=matching"]))
    .split("\0")
    .filter((line) => line !== "");
  const reasons: string[] = [];
  const ignored: string[] = [];
  for (const line of status) {
    if (line.startsWith("!! ")) ignored.push(line.slice(3));
    else reasons.push(`changed or untracked ${line.slice(3).replace(/\/$/, "")}`);
  }
  // Only what preparation wrote may go. An unclassified entry can be unlanded work.
  const classified = await WorktreePreparation.classifyIgnored({
    paths: input.paths,
    worktree,
    controller: checkout,
    ignored,
  });
  for (const entry of classified.tag === "Ok" ? classified.value.unknown : ignored)
    reasons.push(`ignored ${entry.replace(/\/$/, "")}`);
  const tips = ["HEAD"];
  const exclude: string[] = [];
  if (branch !== null) {
    // Git matches a pattern before --branches without the refs/heads/ prefix.
    exclude.push(`--exclude=${branch}`);
    // HEAD can leave the recorded branch, so the branch tip is inspected as well.
    if (await branchExists(worktree, branch)) tips.push(`refs/heads/${branch}`);
  }
  const commits = await git(worktree, [
    "rev-list",
    "--max-count=1",
    ...tips,
    "--not",
    ...exclude,
    "--branches",
    "--remotes",
  ]);
  if (commits !== "") reasons.push("commits that no other branch or remote branch holds");
  return reasons;
}

/**
 * A folder removed by hand leaves its branch. The branch goes only when other branches or
 * remote branches hold its commits, the same rule as for a present worktree.
 */
async function absentWorktree(input: {
  checkout: string;
  worktree: string;
  branch: string | null;
}): Promise<Outcome> {
  const gone = `Worktree ${input.worktree} no longer exists`;
  const { branch } = input;
  if (branch === null || !(await branchExists(input.checkout, branch)))
    return { state: "absent", detail: `${gone}.` };
  // Git keeps the branch checked out in the missing worktree until its record is pruned.
  await git(input.checkout, ["worktree", "prune"]);
  const commits = await git(input.checkout, [
    "rev-list",
    "--max-count=1",
    `refs/heads/${branch}`,
    "--not",
    `--exclude=${branch}`,
    "--branches",
    "--remotes",
  ]);
  if (commits !== "")
    return {
      state: "kept",
      detail: `${gone}, but its branch ${branch} holds commits that no other branch or remote branch holds. Only the person can authorize its deletion.`,
    };
  await git(input.checkout, ["branch", "-D", branch]);
  return {
    state: "absent",
    detail: `${gone}. Removed its branch ${branch}, whose commits other branches hold.`,
  };
}

/**
 * Keep a report worktree unless Git establishes that it holds no unlanded work. Removal uses
 * the non-forcing Git command, so Git also refuses a worktree that changed after inspection.
 */
export async function cleanWorktree(input: {
  paths: ReturnType<typeof OperatorHome.resolve>;
  checkout: string;
  worktree: string;
  branch: string | null;
}): Promise<Outcome> {
  const worktree = await realpath(input.worktree).catch(() => null);
  if (worktree === null) return absentWorktree(input);
  const reasons = await unlanded({ ...input, worktree });
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
