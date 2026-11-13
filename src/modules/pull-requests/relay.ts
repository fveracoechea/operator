import { z } from "zod";
import { ToolInvocation } from "../tool-invocation/main.ts";

async function exists(file: string) {
  return (
    (await Bun.file(file)
      .stat()
      .catch(() => null)) !== null
  );
}

/** The stack parent of a PR and the progress of its relay after the parent merges. */
export const relaySchema = z.object({
  parent: z.object({
    assignment: z.string(),
    number: z.number().int().positive(),
    branch: z.string(),
  }),
  state: z.enum(["stacked", "blocked", "relayed"]),
  // The rebased head, recorded before the push, so a restarted relay does not rebase again.
  rebasedHead: z.string().nullable(),
  blocker: z.object({ reason: z.string(), detail: z.string() }).nullable(),
  // The process that runs the relay now. A gone process or a stale lease frees the claim.
  ownerPid: z.number().int().nullable(),
  leaseAt: z.string().nullable(),
});
export type Relay = z.infer<typeof relaySchema>;
export type Blocker = { reason: string; detail: string };
type Parent = { state: "OPEN" | "MERGED" | "CLOSED"; base: string; head: string };
type Child = { state: "OPEN" | "MERGED" | "CLOSED"; defaultBranch: string | null };

export function stacked(parent: Relay["parent"]): Relay {
  return {
    parent,
    state: "stacked",
    rebasedHead: null,
    blocker: null,
    ownerPid: null,
    leaseAt: null,
  };
}

/** A relay that has not finished needs the parent's state. An ended child PR needs nothing. */
export function needsParent(relay: Relay | null, child: Child): relay is Relay {
  return relay !== null && relay.state !== "relayed" && child.state === "OPEN";
}

/**
 * Decides what the parent's state requires. Only a parent merged into the default branch is
 * relayed. A closed parent or a parent merged elsewhere is an explicit blocker for the person.
 */
export function decideRelay(
  relay: Relay,
  child: Child,
  parent: Parent,
):
  | { action: "none" }
  | { action: "blocked"; blocker: Blocker }
  | { action: "relay"; defaultBranch: string } {
  if (parent.state === "OPEN") return { action: "none" };
  if (parent.state === "CLOSED")
    return {
      action: "blocked",
      blocker: {
        reason: "relay_parent_closed",
        detail: `Parent PR #${relay.parent.number} was closed without a merge. Your PR still targets ${relay.parent.branch}. Ask your SuperAgent.`,
      },
    };
  // A repository without a default branch reports null, which no base name equals.
  if (parent.base !== child.defaultBranch)
    return {
      action: "blocked",
      blocker: {
        reason: "relay_parent_base",
        detail: `Parent PR #${relay.parent.number} merged into ${parent.base}, not the default branch. Ask your SuperAgent.`,
      },
    };
  return { action: "relay", defaultBranch: parent.base };
}

async function git(cwd: string, args: string[]) {
  const result = await ToolInvocation.run({ tool: "git", args, cwd, timeoutMs: 120000 });
  return result.status === "completed"
    ? { ok: result.exitCode === 0, out: result.stdout.trim(), err: result.stderr.trim() }
    : { ok: false, out: "", err: result.detail };
}

const kept = "Your branch and worktree are unchanged.";

type Input = {
  worktree: string;
  branch: string;
  /** The child PR's head and base as GitHub reported them. */
  head: string;
  base: string;
  defaultBranch: string;
  parentHead: string;
  rebasedHead: string | null;
  recordRebase: (head: string) => Promise<boolean>;
  retarget: () => Promise<string | null>;
};

/** The remote that holds the PR branch, and the commits the rebase needs from it. */
async function fetchTargets(input: Input): Promise<Blocker | { remote: string; target: string }> {
  const remote = await git(input.worktree, ["config", `branch.${input.branch}.remote`]);
  if (!remote.ok || remote.out === "")
    return {
      reason: "relay_remote_missing",
      detail: `Branch ${input.branch} has no remote. Push it with git push -u, then wait again. ${kept}`,
    };
  const fetched = await git(input.worktree, [
    "fetch",
    "--quiet",
    remote.out,
    `refs/heads/${input.defaultBranch}`,
  ]);
  const target = fetched.ok ? await git(input.worktree, ["rev-parse", "FETCH_HEAD"]) : fetched;
  if (!target.ok)
    return {
      reason: "relay_fetch_failed",
      detail: `Git could not fetch ${input.defaultBranch}: ${target.err} ${kept}`,
    };
  // The parent's head is local when its owner pushed from this repository. GitHub keeps it as a PR ref.
  // Stryker disable next-line ArrayDeclaration,StringLiteral: no rule: Git fetches a commit that the clone already holds without a failure, so this check only saves a network read, and Operator promises no fetch count
  const local = await git(input.worktree, ["cat-file", "-e", `${input.parentHead}^{commit}`]);
  // Stryker disable next-line ConditionalExpression: no rule: a fetch of a commit that the clone already holds succeeds, so only the network read differs
  if (!local.ok) {
    const parent = await git(input.worktree, ["fetch", "--quiet", remote.out, input.parentHead]);
    if (!parent.ok)
      return {
        reason: "relay_fetch_failed",
        detail: `Git could not fetch the parent head ${input.parentHead}: ${parent.err} ${kept}`,
      };
  }
  return { remote: remote.out, target: target.out };
}

/**
 * The worktree is on the PR branch with no rebase in progress. A stopped relay can leave a
 * half-done rebase, and another checked-out branch must never replace the PR branch.
 */
async function onBranch(input: Input): Promise<Blocker | null> {
  for (const name of ["rebase-merge", "rebase-apply"]) {
    const dir = await git(input.worktree, [
      "rev-parse",
      "--path-format=absolute",
      "--git-path",
      name,
    ]);
    if (!dir.ok || (await exists(dir.out)))
      return {
        reason: "relay_rebase_in_progress",
        detail: `A rebase is in progress in the worktree. Finish or abort it, push, then wait again. ${kept}`,
      };
  }
  const ref = await git(input.worktree, ["symbolic-ref", "--quiet", "HEAD"]);
  return ref.ok && ref.out === `refs/heads/${input.branch}`
    ? null
    : {
        reason: "relay_worktree_branch",
        detail: `The worktree must be on ${input.branch}, not ${ref.out || "a detached HEAD"}. Switch back, then wait again. ${kept}`,
      };
}

/** Rebases only this worktree's branch, and only when every change in it is committed and pushed. */
async function rebase(input: Input, target: string): Promise<Blocker | null> {
  const head = (await git(input.worktree, ["rev-parse", "HEAD"])).out;
  if (head === input.rebasedHead) return null;
  // Only the pushed PR head can already be on the default branch, for example after a manual rebase.
  if (
    head === input.head &&
    (await git(input.worktree, ["merge-base", "--is-ancestor", target, "HEAD"])).ok
  )
    return null;
  const status = await git(input.worktree, ["status", "--porcelain", "--untracked-files=no"]);
  if (!status.ok || status.out !== "")
    return {
      reason: "relay_worktree_unclean",
      detail: `Commit or remove the changed files, push, then wait again. ${kept}`,
    };
  if (head !== input.head)
    return {
      reason: "relay_worktree_unsynced",
      detail: `The worktree is at ${head}, but the PR head is ${input.head}. Push or pull, then wait again. ${kept}`,
    };
  // The commits that the child shares with the parent's head already landed with the parent.
  const upstream = await git(input.worktree, ["merge-base", "HEAD", input.parentHead]);
  const rebased = upstream.ok
    ? await git(input.worktree, ["rebase", "--quiet", "--onto", target, upstream.out])
    : upstream;
  if (!rebased.ok) {
    const conflicts = await git(input.worktree, ["diff", "--name-only", "--diff-filter=U"]);
    const aborted = await git(input.worktree, ["rebase", "--abort"]);
    return {
      reason: "relay_conflict",
      detail: aborted.ok
        ? `The rebase onto ${input.defaultBranch} has conflicts in: ${conflicts.out.split("\n").join(", ") || "unknown files"}. The rebase was aborted. ${kept} Rebase onto ${input.defaultBranch} yourself, push, then wait again.`
        : `The rebase onto ${input.defaultBranch} failed and could not be aborted: ${aborted.err}. Inspect the worktree. Keep all work.`,
    };
  }
  const after = (await git(input.worktree, ["rev-parse", "HEAD"])).out;
  return (await input.recordRebase(after))
    ? null
    : { reason: "relay_claim_lost", detail: "Another process took over the relay. Wait again." };
}

/**
 * Relays a PR from its merged parent's branch to the default branch: rebase, push with a lease
 * on the PR head, then change the PR base. Each step first checks whether it already happened,
 * so a repeated or restarted relay does not repeat a branch operation.
 */
export async function relayBranch(input: Input): Promise<{ blocker: Blocker } | { head: string }> {
  const placed = await onBranch(input);
  if (placed !== null) return { blocker: placed };
  const targets = await fetchTargets(input);
  if ("reason" in targets) return { blocker: targets };
  const blocker = await rebase(input, targets.target);
  if (blocker !== null) return { blocker };
  const head = (await git(input.worktree, ["rev-parse", `refs/heads/${input.branch}`])).out;
  // The push replaces only the PR head that GitHub reported, never a newer push.
  const lease = `--force-with-lease=refs/heads/${input.branch}:${input.head}`;
  if (head !== input.head) {
    const pushed = await git(input.worktree, [
      "push",
      "--quiet",
      lease,
      targets.remote,
      `refs/heads/${input.branch}:refs/heads/${input.branch}`,
    ]);
    if (!pushed.ok)
      return {
        blocker: {
          reason: "relay_push_failed",
          detail: `Git could not push the rebased ${input.branch}: ${pushed.err} The rebased commits stay in the worktree.`,
        },
      };
  }
  if (input.base !== input.defaultBranch) {
    const failed = await input.retarget();
    if (failed !== null)
      return {
        blocker: {
          reason: "relay_retarget_failed",
          detail: `The branch is pushed, but GitHub did not change the PR base to ${input.defaultBranch}: ${failed} Wait again to retry.`,
        },
      };
  }
  return { head };
}
