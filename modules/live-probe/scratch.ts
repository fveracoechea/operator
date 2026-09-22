// Bun has no recursive directory removal API.
import { rm } from "node:fs/promises";

export const PROBE_DIRECTORY = ".operator/local/probe";

export type Scratch = {
  /** The one directory every temporary resource of this run lives under. */
  root: string;
  repo: string;
  worktreePath: string;
  branch: string;
  baseCommit: string;
};

/**
 * Builds the synthetic repository one probe runs in.
 * It holds generated files only and lives under the ignored Operator directory, so no probe
 * reaches the project working tree, its history, or its remote.
 */
export async function makeScratch(request: {
  projectRoot: string;
  runId: string;
}): Promise<Scratch> {
  const root = `${request.projectRoot}/${PROBE_DIRECTORY}/${request.runId}`;
  const repo = `${root}/repo`;

  await Bun.write(`${repo}/README.md`, `# Operator live probe ${request.runId}\n`, {
    createPath: true,
  });
  await Bun.write(
    `${repo}/AGENTS.md`,
    "# Synthetic probe instructions\n\nAnswer only the probe brief.\n",
  );
  await Bun.$`git init -q -b main ${repo}`.quiet();
  await Bun.$`git -C ${repo} add -A`.quiet();
  await Bun.$`git -C ${repo} -c user.email=probe@operator.invalid -c user.name=Operator commit -q -m probe`.quiet();
  const baseCommit = (await Bun.$`git -C ${repo} rev-parse HEAD`.quiet()).stdout.toString().trim();

  return {
    root,
    repo,
    worktreePath: `${root}/worktree`,
    branch: `operator-probe/${request.runId}`,
    baseCommit,
  };
}

/** Waits for one agent answer inside its own window. A window that runs out is a real outcome. */
export async function waitForFile(request: {
  path: string;
  windowMs: number;
}): Promise<{ status: "read"; text: string; waitedMs: number } | { status: "timed-out" }> {
  const started = Bun.nanoseconds();
  const file = Bun.file(request.path);

  for (;;) {
    if (await file.exists()) {
      return {
        status: "read",
        text: await file.text(),
        waitedMs: Math.round((Bun.nanoseconds() - started) / 1_000_000),
      };
    }
    if ((Bun.nanoseconds() - started) / 1_000_000 >= request.windowMs) {
      return { status: "timed-out" };
    }

    await Bun.sleep(50);
  }
}

/** Lists the recorded probe directories this project still holds. */
export async function scratchDirectories(projectRoot: string): Promise<string[]> {
  const root = `${projectRoot}/${PROBE_DIRECTORY}`;
  const found = await Array.fromAsync(
    new Bun.Glob("*/repo/.git/HEAD").scan({ cwd: root, onlyFiles: true, dot: true }),
  ).catch(() => []);

  return [
    ...new Set(
      found.flatMap((entry) => {
        const runId = entry.split("/")[0];
        return runId === undefined ? [] : [`${root}/${runId}`];
      }),
    ),
  ].toSorted();
}

/** Removes one probe directory. It is named by a recorded run, never discovered by a pattern. */
export async function removeScratch(path: string): Promise<void> {
  await rm(path, { force: true, recursive: true });
}
