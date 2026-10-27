// Bun has no realpath API.
import { realpath } from "node:fs/promises";
import { DoAsync, Err, Ok, OkAsync, fromPromise } from "unthrown";
import { DeviceState } from "../device-state/main.ts";
import type { OperatorHome } from "../operator-home/main.ts";
import { ToolInvocation } from "../tool-invocation/main.ts";
import { copyEnvFiles } from "./env-files.ts";

type Paths = ReturnType<typeof OperatorHome.resolve>;
type Failure = { reason: string; detail: string };

async function git(cwd: string, args: string[]) {
  const result = await ToolInvocation.run({
    tool: "git",
    args: ["-C", cwd, ...args],
    timeoutMs: 60000,
  });
  return result.status === "completed" && result.exitCode === 0 ? result.stdout : null;
}

async function commonDirectory(checkout: string) {
  const output = await git(checkout, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  return output === null ? null : realpath(output.trim()).catch(() => null);
}

/** Find the registered project that owns this linked worktree, without adopting a clone. */
function owner(paths: Paths, worktree: string) {
  return DeviceState.listProjects(paths)
    .toAsync()
    .flatMap((listed) =>
      fromPromise(async () => {
        const common = await commonDirectory(worktree);
        for (const project of common === null ? [] : listed.projects) {
          if ((await commonDirectory(project.checkout)) !== common) continue;
          const controller = await realpath(project.checkout);
          return controller === worktree ? null : { repository: project.repository, controller };
        }
        return null;
      }, qualify),
    );
}

async function prepare(input: { controller: string; worktree: string }) {
  const listed = await git(input.controller, [
    "ls-files",
    "-z",
    "--others",
    "--ignored",
    "--exclude-standard",
    "--",
    ":(glob)**/.env*.local",
    // Dependency folders can hold a package's own environment files, and they are large.
    ":(exclude,glob)**/node_modules/**",
  ]);
  if (listed === null)
    return { state: "failed" as const, detail: "Git could not list ignored environment files." };
  const files = await copyEnvFiles({
    ...input,
    files: listed.split("\0").filter((file) => file !== ""),
  });
  const copied = `Copied ${files.copied.length} environment files, preserved ${files.preserved.length}, refused ${files.refused.length}.`;
  const lockfile = (
    await Promise.all(
      ["bun.lock", "bun.lockb"].map((name) => Bun.file(`${input.worktree}/${name}`).exists()),
    )
  ).includes(true);
  if (!lockfile)
    return {
      state: "prepared" as const,
      detail: `${copied} No Bun lockfile, so no dependencies were installed.`,
    };
  // The Bun that runs Operator installs, so preparation does not depend on PATH order.
  const install = await ToolInvocation.run({
    tool: process.execPath,
    args: ["install", "--frozen-lockfile"],
    cwd: input.worktree,
    timeoutMs: 600000,
  });
  if (install.status !== "completed" || install.exitCode !== 0)
    return {
      state: "failed" as const,
      detail: `${copied} bun install --frozen-lockfile failed: ${install.status === "completed" ? (install.stderr || install.stdout).trim() : install.detail}`,
    };
  return {
    state: "prepared" as const,
    detail: `${copied} Installed dependencies from the lockfile.`,
  };
}

function qualify<T>(cause: unknown, defect: (cause: unknown) => T) {
  if (
    cause instanceof Error &&
    "code" in cause &&
    ["ENOENT", "EACCES", "EPERM", "EIO", "EROFS", "ENOSPC", "ENOTDIR", "EEXIST", "ELOOP"].includes(
      String(cause.code),
    )
  )
    return { reason: "preparation_io_failed" as const, detail: String(cause) };
  return defect(cause);
}

function prepareProject(
  paths: Paths,
  worktree: string,
  project: { repository: string; controller: string },
) {
  return DeviceState.beginPreparation(paths, worktree, project.repository)
    .toAsync()
    .flatMap(() =>
      // A failed preparation is still recorded. A killed hook leaves a lease that goes stale.
      fromPromise(async () => {
        const release = DeviceState.holdPreparation(paths, worktree);
        try {
          return await prepare({ controller: project.controller, worktree });
        } catch (cause) {
          return { state: "failed" as const, detail: `Preparation stopped: ${String(cause)}` };
        } finally {
          release();
        }
      }, qualify),
    )
    .flatMap((outcome) =>
      DeviceState.finishPreparation(paths, worktree, outcome).flatMap(() =>
        outcome.state === "failed"
          ? Err<Failure>({ reason: "preparation_failed", detail: outcome.detail })
          : Ok({
              reason: "worktree_prepared",
              data: { worktree, repository: project.repository, detail: outcome.detail },
            }),
      ),
    );
}

/** Prepares every new worktree of a registered project, whoever created it. */
export const WorktreePreparation = {
  prepare(input: { paths: Paths; worktree: string }) {
    return DoAsync()
      .bind("worktree", () => fromPromise(() => realpath(input.worktree), qualify))
      .bind("project", ({ worktree }) => owner(input.paths, worktree))
      .flatMap(({ worktree, project }) =>
        project === null
          ? OkAsync({ reason: "worktree_unregistered", data: { worktree } })
          : prepareProject(input.paths, worktree, project),
      );
  },
};
