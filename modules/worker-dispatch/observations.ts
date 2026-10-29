import { isCodedError } from "../../lib/coded-error.ts";
import { realPathOrNull } from "../../lib/real-path.ts";
// Bun has no directory listing or path API.
import { readdir } from "node:fs/promises";
import path from "node:path";
import { Err, Ok, fromPromise, fromSafePromise } from "unthrown";
import { DeviceState } from "../device-state/main.ts";
import { Herdr } from "../herdr/main.ts";
import type { OperatorHome } from "../operator-home/main.ts";
import { ToolInvocation } from "../tool-invocation/main.ts";

export type Paths = ReturnType<typeof OperatorHome.resolve>;
export type Failure = { reason: string; detail: string };

const preparationWaitMs = 600000;

export function qualify<T>(cause: Error, defect: (cause: Error) => T) {
  if (
    isCodedError(cause) &&
    ["ENOENT", "EACCES", "EPERM", "EIO", "EROFS", "ENOSPC", "ENOTDIR", "EISDIR", "ELOOP"].includes(
      cause.code,
    )
  )
    return { reason: "dispatch_io_failed", detail: String(cause) };
  return defect(cause);
}

/** Every file below the folder, so a replacement sees each earlier report and supporting file. */
export async function listFiles(directory: string) {
  try {
    const entries = await readdir(directory, { recursive: true, withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile())
      .map((entry) => path.relative(directory, path.join(entry.parentPath, entry.name)))
      .toSorted();
  } catch (cause) {
    if (isCodedError(cause) && cause.code === "ENOENT") return [];
    // oxlint-disable-next-line unthrown/no-throw -- The brief writer qualifies this failure.
    throw cause;
  }
}

export function gitBranches(checkout: string) {
  return fromPromise(
    () =>
      ToolInvocation.run({
        tool: "git",
        args: [
          "-C",
          checkout,
          "for-each-ref",
          "--format=%(refname:lstrip=2)",
          "refs/heads",
          "refs/remotes/origin",
        ],
        timeoutMs: 60000,
      }),
    // Stryker disable next-line ConditionalExpression: equivalent: qualify passes any cause without an I/O code to defect, as the other branch does
    (cause, defect) => (cause instanceof Error ? qualify(cause, defect) : defect(cause)),
  ).flatMap((result) =>
    // Stryker disable next-line ConditionalExpression: equivalent: an invocation that did not complete has no exit code, so the exit check alone refuses it
    result.status === "completed" && result.exitCode === 0
      ? Ok(
          new Set(
            result.stdout
              .split("\n")
              .filter((line) => line !== "")
              .map((line) => line.replace(/^origin\//, "")),
          ),
        )
      : Err<Failure>({
          reason: "git_unavailable",
          detail: "Git could not list the project branches. Nothing was launched.",
        }),
  );
}

/**
 * The pushed head of a parent PR's branch. Its owner pushed it with an upstream, so Git names its
 * remote. Each start fetches into its own private ref and leaves `FETCH_HEAD` alone, so two
 * simultaneous starts never read each other's parent. The commit starts the child, so the child
 * tracks no parent branch.
 */
export function parentBase(checkout: string, branch: string) {
  return fromPromise(
    async () => {
      async function git(args: string[]) {
        const result = await ToolInvocation.run({
          tool: "git",
          args: ["-C", checkout, ...args],
          timeoutMs: 60000,
        });
        // Stryker disable next-line ConditionalExpression: equivalent: an invocation that did not complete has no exit code, so the exit check alone refuses it
        return result.status === "completed" && result.exitCode === 0 ? result.stdout.trim() : null;
      }
      const ref = `refs/operator/parents/${crypto.randomUUID()}`;
      const remote = await git(["config", `branch.${branch}.remote`]);
      // A failed fetch leaves the private ref absent, so the read below fails as well.
      if (remote !== null)
        await git([
          "fetch",
          "--quiet",
          "--no-write-fetch-head",
          remote,
          `+refs/heads/${branch}:${ref}`,
        ]);
      const head = await git(["rev-parse", "--verify", `${ref}^{commit}`]);
      await git(["update-ref", "-d", ref]);
      return head === null
        ? Err<Failure>({
            reason: "parent_branch_unavailable",
            detail: `Git could not fetch the pushed parent branch ${branch}. Its owner must push it with an upstream. Nothing was launched.`,
          })
        : Ok(head);
    },
    // Stryker disable next-line ConditionalExpression: equivalent: qualify passes any cause without an I/O code to defect, as the other branch does
    (cause, defect) => (cause instanceof Error ? qualify(cause, defect) : defect(cause)),
  ).flatMap((result) => result);
}

/** The project workspace is the unlinked Herdr workspace whose checkout is the controller. */
export function projectWorkspace(checkout: string) {
  return Herdr.workspaces().flatMap((workspaces) =>
    fromSafePromise(async () => {
      let workspaceId: string | null = null;
      for (const workspace of workspaces)
        if (
          workspaceId === null &&
          !workspace.linked &&
          // Stryker disable next-line ConditionalExpression: equivalent: the real path of a missing checkout is null, which never equals the controller
          workspace.checkout !== null &&
          (await realPathOrNull(workspace.checkout)) === checkout
        )
          workspaceId = workspace.workspaceId;
      return { workspaceId, labels: workspaces.map((workspace) => workspace.label) };
    }),
  );
}

/** The worktree hook records preparation in device state. Dispatch waits for that record. */
export function waitForPreparation(paths: Paths, worktree: string, since: string) {
  return fromSafePromise(async () => {
    const real = await realPathOrNull(worktree);
    if (real === null)
      return Err<Failure>({
        reason: "worktree_missing",
        detail: `Herdr returned ${worktree}, but it does not exist.`,
      });
    const deadline = Date.now() + preparationWaitMs;
    // The pause sits in the loop step, so every pass yields to the event loop.
    for (; Date.now() < deadline; await Bun.sleep(250)) {
      const read = DeviceState.readPreparation(paths, real);
      if (read.tag !== "Ok") return read.as(null);
      const row = read.value;
      if (row !== null && row.startedAt >= since && row.abandoned)
        return Err<Failure>({
          reason: "worktree_setup_failed",
          detail: "The Herdr worktree hook stopped before it recorded a preparation outcome.",
        });
      if (row !== null && row.startedAt >= since && row.state !== "running")
        return row.state === "prepared"
          ? Ok(row.detail)
          : Err<Failure>({ reason: "worktree_setup_failed", detail: row.detail });
    }
    return Err<Failure>({
      reason: "worktree_setup_unconfirmed",
      detail:
        "The Herdr worktree hook did not record a finished preparation. Check the Operator Herdr plugin and its log.",
    });
  }).flatMap((result) => result);
}
