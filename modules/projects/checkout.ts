// Bun has no lstat or realpath API.
import { lstat, realpath } from "node:fs/promises";
import { ToolInvocation } from "../tool-invocation/main.ts";
import { githubIdentity } from "./identity.ts";

export type CheckoutFailure = {
  reason:
    | "git_unavailable"
    | "git_checkout_invalid"
    | "bare_repository"
    | "legacy_project_state"
    | "linked_checkout";
  detail: string;
};
export type Checkout = { checkout: string; repositories: string[] };

export async function inspectCheckout(cwd: string): Promise<Checkout | CheckoutFailure> {
  const bare = await git(cwd, ["rev-parse", "--is-bare-repository"]);
  if ("reason" in bare) return bare;
  if (bare.text === "true")
    return {
      reason: "bare_repository" as const,
      detail: "A bare repository cannot be a controlling checkout. Use its main non-bare checkout.",
    };
  const top = await git(cwd, ["rev-parse", "--show-toplevel"]);
  if ("reason" in top) return top;
  const checkout = await realpath(top.text);
  // Presence alone is sufficient. Never open or traverse legacy state.
  try {
    await lstat(`${checkout}/.operator`);
    return {
      reason: "legacy_project_state" as const,
      detail:
        "This checkout has legacy .operator state. Finish old work with the old release. Then the person must remove that folder before using this release. Operator does not migrate, delete, or repair it.",
    };
  } catch (cause) {
    if (!(cause instanceof Error && "code" in cause && cause.code === "ENOENT")) {
      // oxlint-disable-next-line unthrown/no-throw -- The public project boundary qualifies filesystem errors.
      throw cause;
    }
  }
  const dir = await git(checkout, ["rev-parse", "--absolute-git-dir"]);
  if ("reason" in dir) return dir;
  const common = await git(checkout, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  if ("reason" in common) return common;
  if ((await realpath(dir.text)) !== (await realpath(common.text)))
    return {
      reason: "linked_checkout" as const,
      detail: `A linked worktree cannot control a project. Use the main checkout associated with ${common.text}.`,
    };
  const remotes = await git(checkout, ["remote", "-v"]);
  if ("reason" in remotes) return remotes;
  const repositories = [
    ...new Set(
      remotes.text.split("\n").flatMap((line) => {
        const match = /^\S+\s+(\S+)\s+\(fetch\)$/.exec(line);
        const identity = match?.[1] ? githubIdentity(match[1]) : null;
        return identity === null ? [] : [identity];
      }),
    ),
  ].toSorted();
  return { checkout, repositories };
}

/**
 * The first remote whose configured fetch URL names the repository. Remote names have no
 * authority, so `origin` can be a fork. The configured URL is read before any rewrite rule.
 */
export async function githubRemote(checkout: string, repository: string) {
  const remotes = await git(checkout, ["config", "--get-regexp", "^remote\\..*\\.url$"]);
  if ("reason" in remotes) return null;
  for (const line of remotes.text.split("\n")) {
    const match = /^remote\.(.+)\.url\s+(\S+)$/.exec(line);
    if (match?.[1] && match[2] && githubIdentity(match[2]) === repository) return match[1];
  }
  return null;
}

async function git(cwd: string, args: string[]): Promise<{ text: string } | CheckoutFailure> {
  const result = await ToolInvocation.run({ tool: "git", args, cwd, timeoutMs: 10000 });
  if (result.status !== "completed")
    return { reason: "git_unavailable" as const, detail: result.detail };
  if (result.exitCode !== 0)
    return {
      reason: "git_checkout_invalid" as const,
      detail: result.stderr.trim() || "Git could not resolve this checkout.",
    };
  return { text: result.stdout.trim() };
}
