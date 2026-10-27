// Bun has no realpath, directory listing, or path API.
import { isCodedError } from "../../lib/coded-error.ts";
import { readdir, realpath } from "node:fs/promises";
import path from "node:path";
import { Err, Ok, fromPromise } from "unthrown";
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

export async function realOrNull(file: string) {
  return realpath(file).catch(() => null);
}

/** Every file below the folder, so a replacement sees each earlier report and supporting file. */
export async function listFiles(directory: string) {
  return readdir(directory, { recursive: true, withFileTypes: true })
    .then((entries) =>
      entries
        .filter((entry) => entry.isFile())
        .map((entry) => path.relative(directory, path.join(entry.parentPath, entry.name)))
        .toSorted(),
    )
    .catch(() => []);
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
    (cause, defect) => (cause instanceof Error ? qualify(cause, defect) : defect(cause)),
  ).flatMap((result) =>
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
        return result.status === "completed" && result.exitCode === 0 ? result.stdout.trim() : null;
      }
      const ref = `refs/operator/parents/${crypto.randomUUID()}`;
      const remote = await git(["config", `branch.${branch}.remote`]);
      const fetched =
        remote === null
          ? null
          : await git([
              "fetch",
              "--quiet",
              "--no-write-fetch-head",
              remote,
              `+refs/heads/${branch}:${ref}`,
            ]);
      const head =
        fetched === null ? null : await git(["rev-parse", "--verify", `${ref}^{commit}`]);
      await git(["update-ref", "-d", ref]);
      return head === null
        ? Err<Failure>({
            reason: "parent_branch_unavailable",
            detail: `Git could not fetch the pushed parent branch ${branch}. Its owner must push it with an upstream. Nothing was launched.`,
          })
        : Ok(head);
    },
    (cause, defect) => (cause instanceof Error ? qualify(cause, defect) : defect(cause)),
  ).flatMap((result) => result);
}

/** The project workspace is the unlinked Herdr workspace whose checkout is the controller. */
export function projectWorkspace(checkout: string) {
  return Herdr.workspaces().flatMap((workspaces) =>
    fromPromise(
      async () => {
        let workspaceId: string | null = null;
        for (const workspace of workspaces)
          if (
            workspaceId === null &&
            !workspace.linked &&
            workspace.checkout !== null &&
            (await realOrNull(workspace.checkout)) === checkout
          )
            workspaceId = workspace.workspaceId;
        return { workspaceId, labels: workspaces.map((workspace) => workspace.label) };
      },
      (cause, defect) => (cause instanceof Error ? qualify(cause, defect) : defect(cause)),
    ),
  );
}

/** The worktree hook records preparation in device state. Dispatch waits for that record. */
export function waitForPreparation(paths: Paths, worktree: string, since: string) {
  return fromPromise(
    async () => {
      const real = await realOrNull(worktree);
      if (real === null)
        return Err<Failure>({
          reason: "worktree_missing",
          detail: `Herdr returned ${worktree}, but it does not exist.`,
        });
      const deadline = Date.now() + preparationWaitMs;
      while (Date.now() < deadline) {
        const read = DeviceState.readPreparation(paths, real);
        if (read.tag !== "Ok") return read.flatMap(() => Ok(""));
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
        await Bun.sleep(250);
      }
      return Err<Failure>({
        reason: "worktree_setup_unconfirmed",
        detail:
          "The Herdr worktree hook did not record a finished preparation. Check the Operator Herdr plugin and its log.",
      });
    },
    (cause, defect) => (cause instanceof Error ? qualify(cause, defect) : defect(cause)),
  ).flatMap((result) => result);
}
