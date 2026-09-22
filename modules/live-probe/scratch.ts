// Bun has no recursive directory removal API.
import { rm } from "node:fs/promises";
import { SkillInstall } from "../skill-install/main.ts";

export const PROBE_DIRECTORY = ".operator/local/probe";

export type Target = "opencode" | "claude-code";

/** The instruction files a probe copies out of the project for its synthetic checkout. */
const INSTRUCTION_FILES = ["AGENTS.md", "CLAUDE.md"];

export type Scratch = {
  /** The one directory every temporary resource of this run lives under. */
  root: string;
  repo: string;
  worktreePath: string;
  branch: string;
  baseCommit: string;
  /** The instruction files the probe placed. A loading check reads these names back. */
  instructions: string[];
  /** The skills the probe installed. A loading check reads these names back. */
  skills: string[];
};

/**
 * Copies the project's own instruction files into the synthetic checkout.
 * The probe reads them and never writes to the project, and the launched host then loads the
 * files this project really ships rather than a placeholder that proves nothing about it.
 */
async function copyInstructions(projectRoot: string, repo: string): Promise<string[]> {
  const placed: string[] = [];
  for (const name of INSTRUCTION_FILES) {
    const source = Bun.file(`${projectRoot}/${name}`);
    if (await source.exists()) {
      await Bun.write(`${repo}/${name}`, await source.text(), { createPath: true });
      placed.push(name);
    }
  }

  return placed;
}

/**
 * Builds the synthetic repository one probe runs in.
 * It holds the project's instruction files, the skills this release installs, and generated
 * files, and it lives under the ignored Operator directory, so no probe reaches the project
 * working tree, its history, or its remote.
 */
export async function makeScratch(request: {
  projectRoot: string;
  runId: string;
  targets: Target[];
}): Promise<Scratch> {
  const root = `${request.projectRoot}/${PROBE_DIRECTORY}/${request.runId}`;
  const repo = `${root}/repo`;

  await Bun.write(`${repo}/README.md`, `# Operator live probe ${request.runId}\n`, {
    createPath: true,
  });
  const instructions = await copyInstructions(request.projectRoot, repo);
  if (instructions.length === 0) {
    await Bun.write(
      `${repo}/AGENTS.md`,
      "# Synthetic probe instructions\n\nAnswer only the probe brief.\n",
    );
    instructions.push("AGENTS.md");
  }
  const installed = await SkillInstall.run({ projectRoot: repo, targets: request.targets });
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
    instructions,
    skills: [
      ...new Set([...installed.installed, ...installed.adopted].map((one) => one.skill)),
    ].toSorted(),
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
