// Bun has no realpath API.
import { isCodedError, type CodedError } from "../../lib/coded-error.ts";
import { realpath } from "node:fs/promises";
import { DoAsync, Err, Ok, OkAsync, fromPromise } from "unthrown";
import { DeviceState } from "../device-state/main.ts";
import type { OperatorHome } from "../operator-home/main.ts";
import { ToolInvocation } from "../tool-invocation/main.ts";
import { approvedEnvFile, copyEnvFiles } from "./env-files.ts";
import { classifyIgnored } from "./generated.ts";

type Paths = ReturnType<typeof OperatorHome.resolve>;
type Failure = { reason: string; detail: string };

async function git(cwd: string, args: string[]) {
  const result = await ToolInvocation.run({
    tool: "git",
    args: ["-C", cwd, ...args],
    timeoutMs: 60000,
  });
  // Stryker disable next-line ConditionalExpression: equivalent: a result that is not completed has no exit code, so the exit check refuses it too
  return result.status === "completed" && result.exitCode === 0 ? result.stdout : null;
}

async function commonDirectory(checkout: string) {
  const output = await git(checkout, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  // Stryker disable next-line ArrowFunction: equivalent: an undefined directory matches no project, as null does
  return output === null ? null : realpath(output.trim()).catch(() => null);
}

/** Find the registered project that owns this linked worktree, without adopting a clone. */
function owner(paths: Paths, worktree: string) {
  return DeviceState.listProjects(paths)
    .toAsync()
    .flatMap((listed) =>
      fromPromise(
        async () => {
          const common = await commonDirectory(worktree);
          for (const project of common === null ? [] : listed.projects) {
            if ((await commonDirectory(project.checkout)) !== common) continue;
            const controller = await realpath(project.checkout);
            return controller === worktree ? null : { repository: project.repository, controller };
          }
          return null;
        },
        (cause, defect) => (isCodedError(cause) ? qualify(cause, defect) : defect(cause)),
      ),
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
  // Stryker disable next-line ConditionalExpression: equivalent: a result that is not completed has no exit code, so the exit check fails it too
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

function qualify<T>(cause: CodedError, defect: (cause: CodedError) => T) {
  if (
    ["ENOENT", "EACCES", "EPERM", "EIO", "EROFS", "ENOSPC", "ENOTDIR", "EEXIST", "ELOOP"].includes(
      cause.code,
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
      fromPromise(
        async () => {
          const release = DeviceState.holdPreparation(paths, worktree);
          try {
            return await prepare({ controller: project.controller, worktree });
          } catch (cause) {
            return { state: "failed" as const, detail: `Preparation stopped: ${String(cause)}` };
          } finally {
            release();
          }
        },
        (cause, defect) => (isCodedError(cause) ? qualify(cause, defect) : defect(cause)),
      ),
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

async function sameFile(first: string, second: string) {
  const [a, b] = [Bun.file(first), Bun.file(second)];
  if (!(await a.exists()) || !(await b.exists())) return false;
  return Bun.deepEquals(await a.bytes(), await b.bytes());
}

/** Which ignored entries of a prepared worktree this module wrote. */
function classify(input: {
  paths: Paths;
  worktree: string;
  controller: string;
  ignored: string[];
}) {
  return DeviceState.readPreparation(input.paths, input.worktree)
    .toAsync()
    .flatMap((preparation) =>
      fromPromise(
        async () => {
          // A running preparation can still write, and an unprepared worktree holds no output.
          if (preparation === null || (preparation.state === "running" && !preparation.abandoned))
            return { generated: [], unknown: input.ignored };
          const listed = await git(input.worktree, ["ls-files", "-z"]);
          if (listed === null) return { generated: [], unknown: input.ignored };
          const copiedUnchanged = new Set<string>();
          for (const entry of input.ignored)
            if (
              approvedEnvFile(entry) &&
              (await sameFile(`${input.worktree}/${entry}`, `${input.controller}/${entry}`))
            )
              copiedUnchanged.add(entry);
          return classifyIgnored({
            ignored: input.ignored,
            // The empty name after the last separator matches no manifest or lockfile.
            tracked: new Set(listed.split("\0")),
            copiedUnchanged,
          });
        },
        (cause, defect) => (isCodedError(cause) ? qualify(cause, defect) : defect(cause)),
      ),
    );
}

/** Prepares every new worktree of a registered project, whoever created it. */
export const WorktreePreparation = {
  prepare(input: { paths: Paths; worktree: string }) {
    return DoAsync()
      .bind("worktree", () =>
        fromPromise(
          () => realpath(input.worktree),
          (cause, defect) => (isCodedError(cause) ? qualify(cause, defect) : defect(cause)),
        ),
      )
      .bind("project", ({ worktree }) => owner(input.paths, worktree))
      .flatMap(({ worktree, project }) =>
        project === null
          ? OkAsync({ reason: "worktree_unregistered", data: { worktree } })
          : prepareProject(input.paths, worktree, project),
      );
  },
  /**
   * Sorts a prepared worktree's ignored entries into preparation output and unknown content.
   * Cleanup may dispose the output. Unknown content can be unlanded work.
   */
  classifyIgnored(input: {
    paths: Paths;
    worktree: string;
    controller: string;
    ignored: string[];
  }) {
    return classify(input);
  },
};
