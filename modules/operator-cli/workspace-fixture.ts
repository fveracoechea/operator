// Bun has no recursive directory removal or real-path API.
import { realpath, rm } from "node:fs/promises";

const cliPath = new URL("../../cli.ts", import.meta.url).pathname;
const fakeHerdrPath = new URL("./fake-herdr.sh", import.meta.url).pathname;
const fakeGithubPath = new URL("./fake-gh.ts", import.meta.url).pathname;

export type Workspace = {
  root: string;
  repo: string;
  herdr: string;
  github: string;
  bin: string;
};

export type WorkspaceOptions = {
  /** The contents of `.operator/config.json` in the fixture repository. */
  config?: unknown;
  /** Extra files committed into the fixture repository before the first commit. */
  files?: Record<string, string>;
};

/**
 * A fixture repository with the Herdr and GitHub fakes on a PATH that holds no real one.
 * Every command runs through the real CLI against real Git and real SQLite, and each external
 * tool is controlled at its own interface rather than mocked by path.
 */
export type Workspaces = ReturnType<typeof workspaces>;

export function workspaces() {
  const roots: string[] = [];

  return {
    async make(options: WorkspaceOptions = {}): Promise<Workspace> {
      const root = `${Bun.env.TMPDIR ?? "/tmp"}/operator-${crypto.randomUUID()}`;
      roots.push(root);

      const workspace: Workspace = {
        root,
        repo: `${root}/repo`,
        herdr: `${root}/herdr`,
        github: `${root}/github`,
        bin: `${root}/bin`,
      };
      await Bun.$`mkdir -p ${workspace.repo} ${workspace.herdr} ${workspace.github} ${workspace.bin}`.quiet();
      await Bun.$`cp ${fakeHerdrPath} ${workspace.bin}/herdr`.quiet();
      await Bun.$`chmod +x ${workspace.bin}/herdr`.quiet();
      // The GitHub fake answers as `gh` on the same path, so tracker commands reach it through
      // the real external interface instead of a module replaced by path.
      await Bun.write(`${workspace.bin}/gh`, `#!/bin/sh\nexec bun ${fakeGithubPath} "$@"\n`);
      await Bun.$`chmod +x ${workspace.bin}/gh`.quiet();

      const config = options.config ?? { crew: { host: "claude-code" } };
      await Bun.write(`${workspace.repo}/.operator/config.json`, `${JSON.stringify(config)}\n`);
      await Bun.write(`${workspace.repo}/README.md`, "# Fixture\n");
      for (const [path, content] of Object.entries(options.files ?? {})) {
        await Bun.write(`${workspace.repo}/${path}`, content, { createPath: true });
      }

      await Bun.$`git init -b main ${workspace.repo}`.quiet();
      await Bun.$`git -C ${workspace.repo} add -A`.quiet();
      await Bun.$`git -C ${workspace.repo} -c user.email=t@example.com -c user.name=Test commit -m first`.quiet();

      // The CLI reports the directory it resolved, so the fixture compares against the same reading.
      workspace.repo = await realpath(workspace.repo);
      return workspace;
    },

    async removeAll(): Promise<void> {
      await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
    },
  };
}

export async function headCommit(workspace: Workspace, cwd = workspace.repo): Promise<string> {
  return (await Bun.$`git -C ${cwd} rev-parse HEAD`.quiet()).stdout.toString().trim();
}

/**
 * The PATH a fixture command runs with.
 * The fakes come first, and every directory holding a real `gh` or `herdr` is dropped, so no
 * test can reach the real tool. A test that deletes a fake to prove the tool is absent then
 * proves exactly that, instead of falling through to the one installed on this machine.
 */
function fixturePath(bin: string): string {
  const inherited = (process.env.PATH ?? "").split(":").filter((one) => one.length > 0);
  const kept = inherited.filter(
    (directory) =>
      Bun.which("gh", { PATH: directory }) === null &&
      Bun.which("herdr", { PATH: directory }) === null,
  );
  return [bin, ...kept].join(":");
}

export async function runOperator(workspace: Workspace, args: string[], cwd = workspace.repo) {
  const child = Bun.spawn(["bun", cliPath, ...args], {
    cwd,
    stderr: "pipe",
    stdout: "pipe",
    env: {
      ...process.env,
      PATH: fixturePath(workspace.bin),
      HERDR_FAKE_DIR: workspace.herdr,
      GH_FAKE_DIR: workspace.github,
    },
  });
  const [exitCode, stderr, stdout] = await Promise.all([
    child.exited,
    new Response(child.stderr).text(),
    new Response(child.stdout).text(),
  ]);
  return { exitCode, stderr, stdout };
}

export async function runJson(workspace: Workspace, args: string[], cwd = workspace.repo) {
  const result = await runOperator(workspace, [...args, "--json"], cwd);
  return { ...result, json: JSON.parse(result.stdout) };
}

/** Every Herdr call the fake recorded, so a test can assert what was and was not launched. */
export async function herdrCalls(workspace: Workspace): Promise<string[]> {
  const file = Bun.file(`${workspace.herdr}/calls.log`);
  return (await file.exists())
    ? (await file.text()).split("\n").filter((line) => line.length > 0)
    : [];
}

/** Every `gh` call the fake recorded, so a test can assert what was and was not requested. */
export async function githubCalls(workspace: Workspace): Promise<string[]> {
  const file = Bun.file(`${workspace.github}/calls.log`);
  return (await file.exists())
    ? (await file.text()).split("\n").filter((line) => line.length > 0)
    : [];
}

/** Stops every agent the fake holds, the way a host that exited or crashed would. */
export async function stopFakeAgents(workspace: Workspace): Promise<void> {
  await rm(`${workspace.herdr}/agents`, { force: true, recursive: true });
}

/** Marks one agent live, as a start Herdr accepted but never answered would leave it. */
export async function markFakeAgent(
  workspace: Workspace,
  name: string,
  paneId = "w1:p1",
): Promise<void> {
  await Bun.write(`${workspace.herdr}/agents/${name}`, paneId);
}

/** A fresh request identity. Every mutation carries one. */
export function requestId(): string {
  return crypto.randomUUID();
}
