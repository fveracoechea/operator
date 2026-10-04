// Bun has no recursive directory removal or real-path API.
import { mkdirSync, readdirSync, rmSync, symlinkSync } from "node:fs";
import { realpath, rm } from "node:fs/promises";

const cliPath = new URL("../../cli.ts", import.meta.url).pathname;
const fakeHerdrPath = new URL("./fake-herdr.sh", import.meta.url).pathname;
const fakeGithubPath = new URL("./fake-gh.ts", import.meta.url).pathname;
const wakePluginPath = new URL("../../herdr/herdr-plugin.toml", import.meta.url).pathname;

/**
 * The `gh` on a fixture path. Every readiness check reads `gh --version`, so the script answers
 * it without a Bun process, and the fake answers everything else. A `version-new` file in the
 * fake directory reports an upgraded GitHub CLI: its text, or 2.1.0 when it is empty.
 */
const GITHUB_FAKE_SCRIPT = [
  "#!/bin/sh",
  'if [ "${1:-}" = "--version" ]; then',
  "  version=2.0.0",
  '  if [ -f "$GH_FAKE_DIR/version-new" ]; then',
  "    version=$(tr -d ' \\t\\r\\n' < \"$GH_FAKE_DIR/version-new\")",
  '    [ -n "$version" ] || version=2.1.0',
  "  fi",
  '  echo "gh version $version"',
  "  exit 0",
  "fi",
  `exec bun ${fakeGithubPath} "$@"`,
  "",
].join("\n");

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
  /** The committed `operator-gate.json`, or null for a project that declares no gate. */
  gate?: unknown;
};

/**
 * The project gate each fixture commits, which the default submitted check satisfies. Its one
 * command passes at once, so a gate run on a fixture base proves the run path and nothing else.
 */
export const FIXTURE_GATE = {
  $schema: "./node_modules/@fveracoechea/operator/gate.schema.json",
  commands: [{ name: "quality", argv: ["true"], timeoutSeconds: 1800 }],
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
      // Request files go in their own folder, because a file written next to an Operative
      // worktree during an attempt is an outside change (ADR 0018).
      await Bun.$`mkdir -p ${workspace.repo} ${workspace.herdr} ${workspace.github} ${workspace.bin} ${root}/inputs`.quiet();
      await Bun.$`cp ${fakeHerdrPath} ${workspace.bin}/herdr`.quiet();
      await Bun.$`chmod +x ${workspace.bin}/herdr`.quiet();
      // The GitHub fake answers as `gh` on the same path, so tracker commands reach it through
      // the real external interface instead of a module replaced by path.
      await Bun.write(`${workspace.bin}/gh`, GITHUB_FAKE_SCRIPT);
      await Bun.$`chmod +x ${workspace.bin}/gh`.quiet();

      for (const [name, script] of Object.entries(options.tools ?? {})) {
        await Bun.write(`${workspace.bin}/${name}`, `#!/bin/sh\n${script}\n`);
        await Bun.$`chmod +x ${workspace.bin}/${name}`.quiet();
      }

      const config = options.config ?? { crew: { host: "claude-code" } };
      await Bun.write(`${workspace.repo}/.operator/config.json`, `${JSON.stringify(config)}\n`);
      await Bun.write(`${workspace.repo}/README.md`, "# Fixture\n");
      const gate = options.gate === undefined ? FIXTURE_GATE : options.gate;
      if (gate !== null) {
        await Bun.write(`${workspace.repo}/operator-gate.json`, `${JSON.stringify(gate)}\n`);
      }
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
 * The tools a fixture PATH hides: the two it fakes, and the agent hosts, which a test that needs
 * one puts in its own fixture `tools`. A host installed on the machine would otherwise answer
 * every readiness check, so a local run would read a different machine than CI, and one real
 * host version read costs more than the CLI run that asks for it.
 */
const HIDDEN_TOOLS = ["gh", "herdr", "claude", "opencode"];

// Isolated test files reuse a worker process, so each fixture instance needs its own mirror root.
const mirrorRoot = `${Bun.env.TMPDIR ?? "/tmp"}/operator-path-${crypto.randomUUID()}`;
const mirrors = new Map<string, string>();

process.on("exit", () => rmSync(mirrorRoot, { force: true, recursive: true }));

function entriesOf(directory: string): string[] {
  try {
    return readdirSync(directory);
  } catch {
    // A directory this process cannot read holds nothing a fixture can reach either.
    return [];
  }
}

/**
 * A stand-in for one PATH directory that links everything except the hidden tools.
 * Dropping the whole directory instead would take the rest of the machine with it: on a
 * GitHub runner `gh` sits in `/usr/bin` beside `git`, and a fixture repository needs Git.
 */
function mirrorOf(directory: string): string {
  const made = mirrors.get(directory);
  if (made !== undefined) {
    return made;
  }

  const mirror = `${mirrorRoot}/${mirrors.size}`;
  mkdirSync(mirror, { recursive: true });
  for (const name of entriesOf(directory)) {
    if (!HIDDEN_TOOLS.includes(name)) {
      symlinkSync(`${directory}/${name}`, `${mirror}/${name}`);
    }
  }
  mirrors.set(directory, mirror);
  return mirror;
}

/**
 * The PATH a fixture command runs with.
 * The fakes come first, and every real `gh`, `herdr`, or agent host is hidden, so no test can
 * reach the real tool. A test that deletes a fake to prove the tool is absent then proves exactly
 * that, instead of falling through to the one installed on this machine.
 */
function fixturePath(bin: string): string {
  const inherited = (process.env.PATH ?? "").split(":").filter((one) => one.length > 0);
  const usable = inherited.map((directory) =>
    HIDDEN_TOOLS.some((tool) => Bun.which(tool, { PATH: directory }) !== null)
      ? mirrorOf(directory)
      : directory,
  );
  return [bin, ...usable].join(":");
}

/**
 * The environment that puts the GitHub fake on the path of one directory, for a test that
 * builds its own project instead of a fixture repository. The fake keeps its state under
 * `<directory>/github`.
 */
export async function githubFakeEnvironment(directory: string): Promise<Record<string, string>> {
  const bin = `${directory}/bin`;
  await Bun.$`mkdir -p ${bin} ${directory}/github`.quiet();
  await Bun.write(`${bin}/gh`, GITHUB_FAKE_SCRIPT);
  await Bun.$`chmod +x ${bin}/gh`.quiet();
  return { PATH: fixturePath(bin), GH_FAKE_DIR: `${directory}/github` };
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
      // A run inside a Herdr session inherits the real Herdr and its plugin directory. The
      // wake reads both, so the fake takes their place.
      HERDR_BIN_PATH: `${workspace.bin}/herdr`,
      HERDR_PLUGIN_CONFIG_DIR: "",
      HERDR_FAKE_DIR: workspace.herdr,
      HERDR_FAKE_REPO: workspace.repo,
      HERDR_FAKE_PLUGIN_PATH: wakePluginPath,
      HERDR_WORKSPACE_ID: "w0",
      HERDR_PANE_ID: "w0:p1",
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
  sourceId: string | null;
  assignmentId: string | null;
  attemptId: string | null;
  questionId: string | null;
  reviewId: string | null;
  revision: number | null;
  blocker: string | null;
  planningRecords: Array<Record<string, unknown>> | null;
  detail: string;
  command: string;
};

/** One wait of the next-actions contract. */
export type NextWait = {
  wait: string;
  assignmentId: string | null;
  sourceId: string | null;
  attemptId: string | null;
  agentName: string | null;
  command: string | null;
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

/**
 * Runs the project gate on one commit of one source through the real CLI. The Herdr fake types
 * the runner line into its shell, so the real runner records each outcome before this returns.
 */
export async function runGate(
  workspace: Workspace,
  request: { ownerToken: string; commit: string; sourceId: string; approvalId?: string },
) {
  return runJson(workspace, [
    "gate",
    "run",
    "--request",
    requestId(),
    "--owner-token",
    request.ownerToken,
    "--source",
    request.sourceId,
    "--commit",
    request.commit,
    ...(request.approvalId === undefined ? [] : ["--approval", request.approvalId]),
  ]);
}

/**
 * Passes the base gate that the first code dispatch of an attempt waits for, as the Operator
 * does when `crew next` offers `run_gate`. Any other attempt is left as it is.
 */
export async function passBaseGate(
  workspace: Workspace,
  request: { ownerToken: string; attemptId: string; commit: string },
) {
  const next = await nextActions(workspace);
  const owed = next.actions.find(
    (one) => one.action === "run_gate" && one.attemptId === request.attemptId,
  );
  if (owed === undefined) {
    return null;
  }
  const entries: Array<{ assignmentId: string; sourceId: string }> =
    next.json.data.frontier.active ?? [];
  const sourceId = entries.find((one) => one.assignmentId === owed.assignmentId)?.sourceId;
  if (sourceId === undefined) {
    throw new Error(`the frontier names no source for assignment ${owed.assignmentId}`);
  }
  const ran = await runGate(workspace, {
    ownerToken: request.ownerToken,
    commit: request.commit,
    sourceId,
  });
  // The gate run is setup, so a test that reads the Herdr calls reads only what it drives next.
  // A gate that cannot start is left for the dispatch to refuse, as a test of that refusal reads.
  if (ran.json.reason === "gate_run_started") {
    await rm(`${workspace.herdr}/calls.log`, { force: true });
  }
  return ran;
}

/**
 * A Git on the fixture path that stops one CLI process at its first patch identity, which a landing
 * plan reads after the branch tip. Only a process run with `env` stops, so a test can change the
 * crew state between the plan and the transaction that checks it.
 */
export async function pausedGit(workspace: Workspace) {
  const real = Bun.which("git");
  const directory = `${workspace.root}/git-pause`;
  await Bun.$`mkdir -p ${directory}`.quiet();
  await Bun.write(
    `${workspace.bin}/git`,
    [
      "#!/bin/sh",
      // The guard of ADR 0018 and `-C <repo>` come before the subcommand.
      'if [ -n "$GIT_PAUSE_DIR" ] && [ "$6" = "patch-id" ]; then',
      '  : > "$GIT_PAUSE_DIR/reached"',
      '  while [ ! -f "$GIT_PAUSE_DIR/release" ]; do sleep 0.05; done',
      "fi",
      `exec ${real} "$@"`,
      "",
    ].join("\n"),
  );
  await Bun.$`chmod +x ${workspace.bin}/git`.quiet();
  return {
    env: { GIT_PAUSE_DIR: directory },
    async reached() {
      while (!(await Bun.file(`${directory}/reached`).exists())) {
        await Bun.sleep(50);
      }
    },
    async release() {
      await Bun.write(`${directory}/release`, "");
    },
  };
}
