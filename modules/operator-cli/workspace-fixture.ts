// Bun has no recursive directory removal or real-path API.
import { realpath, rm } from "node:fs/promises";

const cliPath = new URL("../../cli.ts", import.meta.url).pathname;
const fakeHerdrPath = new URL("./fake-herdr.sh", import.meta.url).pathname;

export type Workspace = { root: string; repo: string; herdr: string; bin: string };

export type WorkspaceOptions = {
  /** The contents of `.operator/config.json` in the fixture repository. */
  config?: unknown;
  /** Extra files committed into the fixture repository before the first commit. */
  files?: Record<string, string>;
};

/**
 * A fixture repository with the Herdr fake on its own PATH.
 * Every command runs through the real CLI against real Git and real SQLite, and Herdr is
 * controlled at its own external interface rather than mocked by path.
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
        bin: `${root}/bin`,
      };
      await Bun.$`mkdir -p ${workspace.repo} ${workspace.herdr} ${workspace.bin}`.quiet();
      await Bun.$`cp ${fakeHerdrPath} ${workspace.bin}/herdr`.quiet();
      await Bun.$`chmod +x ${workspace.bin}/herdr`.quiet();

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

export async function runOperator(workspace: Workspace, args: string[], cwd = workspace.repo) {
  const child = Bun.spawn(["bun", cliPath, ...args], {
    cwd,
    stderr: "pipe",
    stdout: "pipe",
    env: {
      ...process.env,
      PATH: `${workspace.bin}:${process.env.PATH ?? ""}`,
      HERDR_FAKE_DIR: workspace.herdr,
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

/** A fresh request identity. Every mutation carries one. */
export function requestId(): string {
  return crypto.randomUUID();
}
