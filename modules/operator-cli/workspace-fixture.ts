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
  /** Extra executables on the fixture path, such as the agent hosts a readiness check reads. */
  tools?: Record<string, string>;
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

      for (const [name, script] of Object.entries(options.tools ?? {})) {
        await Bun.write(`${workspace.bin}/${name}`, `#!/bin/sh\n${script}\n`);
        await Bun.$`chmod +x ${workspace.bin}/${name}`.quiet();
      }

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

export async function runOperator(
  workspace: Workspace,
  args: string[],
  cwd = workspace.repo,
  env: Record<string, string> = {},
) {
  const child = Bun.spawn(["bun", cliPath, ...args], {
    cwd,
    stderr: "pipe",
    stdout: "pipe",
    env: {
      ...process.env,
      PATH: fixturePath(workspace.bin),
      HERDR_FAKE_DIR: workspace.herdr,
      GH_FAKE_DIR: workspace.github,
      ...env,
    },
  });
  const [exitCode, stderr, stdout] = await Promise.all([
    child.exited,
    new Response(child.stderr).text(),
    new Response(child.stdout).text(),
  ]);
  return { exitCode, stderr, stdout };
}

export async function runJson(
  workspace: Workspace,
  args: string[],
  cwd = workspace.repo,
  env: Record<string, string> = {},
) {
  const result = await runOperator(workspace, [...args, "--json"], cwd, env);
  return { ...result, json: JSON.parse(result.stdout) };
}

/**
 * The reports the fake Herdr answers a probe brief with, one file per step.
 * A step with no report is a launched agent that never answered, which is how a test drives the
 * bounded observation window to its limit.
 */
export async function seedProbeReports(
  workspace: Workspace,
  reports: Record<string, unknown>,
): Promise<void> {
  for (const [step, report] of Object.entries(reports)) {
    await Bun.write(`${workspace.herdr}/probe/${step}.json`, JSON.stringify(report), {
      createPath: true,
    });
  }
}

/** The partial work one interrupted agent leaves in its checkout before it is stopped. */
export async function seedProbePartial(workspace: Workspace, text: string): Promise<void> {
  await Bun.write(`${workspace.herdr}/probe/interruption.partial`, text, { createPath: true });
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

/** One action of the next-actions contract, as a caller reads it out of the JSON result. */
export type NextAction = {
  action: string;
  rank: number;
  assignmentId: string | null;
  attemptId: string | null;
  questionId: string | null;
  reviewId: string | null;
  revision: number | null;
  blocker: string | null;
  detail: string;
  command: string;
};

/** One wait of the next-actions contract. */
export type NextWait = {
  wait: string;
  assignmentId: string;
  attemptId: string | null;
  agentName: string | null;
  detail: string;
};

/**
 * The one read-only reading a session takes before it acts.
 * Every coordination test drives the shipped CLI through this, so the order, the gates, and the
 * exit meaning are asserted where a session reads them.
 */
export async function nextActions(workspace: Workspace, targets: string[] = ["--claude"]) {
  const result = await runJson(workspace, ["crew", "next", ...targets]);
  const actions: NextAction[] = result.json.data?.actions ?? [];
  const waits: NextWait[] = result.json.data?.waits ?? [];
  const blockers: Array<{ reason: string; [key: string]: unknown }> = result.json.blockers ?? [];

  return {
    ...result,
    actions,
    waits,
    blockers,
    names: actions.map((one) => one.action),
    waiting: waits.map((one) => one.wait),
    reasons: blockers.map((one) => one.reason),
    forAction(name: string): NextAction[] {
      return actions.filter((one) => one.action === name);
    },
    of(name: string): NextAction {
      const found = actions.find((one) => one.action === name);
      if (found === undefined) {
        throw new Error(`the next actions carry no ${name}: ${actions.map((one) => one.action)}`);
      }
      return found;
    },
  };
}

/**
 * Takes crew ownership and answers with the owner token every mutation carries.
 * A takeover names the ownership revision it inspected, so two sessions cannot both believe
 * they won.
 */
export async function ownCrew(
  workspace: Workspace,
  options: { label?: string; takeoverFrom?: number } = {},
): Promise<string> {
  const taken = await runJson(workspace, [
    "crew",
    "own",
    "--request",
    requestId(),
    "--owner-label",
    options.label ?? "operator-session",
    ...(options.takeoverFrom === undefined
      ? []
      : ["--takeover", "--ownership-revision", String(options.takeoverFrom)]),
  ]);
  return taken.json.data.ownerToken;
}
