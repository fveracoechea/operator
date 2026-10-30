import { afterEach, beforeEach, expect, test } from "bun:test";
// Bun has no temporary-directory, symlink, permission, or recursive removal API.
import { chmod, cp, mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { z } from "zod";
import { Environment } from "../environment/main.ts";
import { fakeHerdrScript } from "./herdr-fixture.ts";

let root = "";
let checkout = "";
const cli = Bun.fileURLToPath(new URL("../../cli.ts", import.meta.url));
const gitEnv = {
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "Fixture",
  GIT_AUTHOR_EMAIL: "fixture@example.com",
  GIT_COMMITTER_NAME: "Fixture",
  GIT_COMMITTER_EMAIL: "fixture@example.com",
};

function environment() {
  return Environment.child({
    ...gitEnv,
    HOME: `${root}/home`,
    XDG_CONFIG_HOME: `${root}/config`,
    XDG_STATE_HOME: `${root}/state`,
    BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0",
    HERDR_SOCKET_PATH: `${root}/herdr.sock`,
    PATH: `${root}/tools:${Environment.read().PATH}`,
  });
}

async function exec(args: string[], cwd = checkout) {
  const child = Bun.spawn(args, { cwd, env: environment(), stdout: "pipe", stderr: "pipe" });
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { code, stdout, stderr };
}

async function run(args: string[], cwd = checkout) {
  const result = await exec([process.execPath, cli, ...args, "--json"], cwd);
  return { code: result.code, output: JSON.parse(result.stdout) as unknown, stderr: result.stderr };
}

async function git(...args: string[]) {
  const result = await exec(["git", ...args]);
  expect(result.code, result.stderr).toBe(0);
  return result.stdout.trim();
}

async function tool(name: string, script: string) {
  await Bun.write(`${root}/tools/${name}`, script, { createPath: true });
  await chmod(`${root}/tools/${name}`, 0o755);
}

const plan = {
  trackerKey: "github:example/one#10",
  assignments: [
    {
      key: "investigate",
      trackerKey: "github:example/one#11",
      instructions: "Read the module and report the gaps.",
      completion: "report",
      resources: "pane",
      dependencies: [],
    },
    {
      key: "implement",
      trackerKey: "github:example/one#12",
      instructions: "Implement the accepted report.",
      completion: "pr",
      resources: "worktree",
      branch: "task/12-implement",
      profile: "careful",
      dependencies: [],
    },
    {
      key: "follow",
      trackerKey: "github:example/one#13",
      instructions: "Use the accepted investigation.",
      completion: "report",
      resources: "pane",
      dependencies: ["investigate"],
    },
  ],
};

beforeEach(async () => {
  root = await realpath(await mkdtemp(path.join(tmpdir(), "operator-dispatch-")));
  checkout = `${root}/checkout`;
  await mkdir(checkout);
  await git("init", "-q", "-b", "main");
  await git("remote", "add", "origin", "https://github.com/example/one.git");
  await Bun.write(`${checkout}/package.json`, JSON.stringify({ name: "fixture", private: true }));
  await Bun.write(`${checkout}/.gitignore`, ".env*\nnode_modules\n");
  expect((await exec([process.execPath, "install"])).code).toBe(0);
  await git("add", ".");
  await git("commit", "-q", "-m", "fixture");
  await Bun.write(`${checkout}/.env.local`, "TOKEN=local\n");
  await Bun.write(`${checkout}/apps/web/.env.development.local`, "NESTED=1\n", {
    createPath: true,
  });
  await Bun.write(`${checkout}/.env`, "SHARED=never-copied\n");
  await Bun.write(`${checkout}/.env.local.backup`, "never-copied\n");

  await tool("herdr", fakeHerdrScript(root));
  // Readiness accepts only a global command that links to the running entry point.
  await symlink(cli, `${root}/tools/operator`);
  await tool("gh", `#!${process.execPath}\nprocess.exit(process.argv[2] === "auth" ? 0 : 99);\n`);
  await tool(
    "opencode",
    `#!${process.execPath}\nconst dir=decodeURIComponent(process.argv[4].split("=")[1]);\nconsole.log(JSON.stringify({location:{directory:dir},data:[{providerID:"test",id:"reasoner",enabled:true,variants:[{id:"medium"},{id:"high"}]},{providerID:"test",id:"writer",enabled:true,variants:[{id:"medium"}]}]}));\n`,
  );
  await Bun.write(
    `${root}/config/operator/config.json`,
    JSON.stringify({
      superAgent: { host: "opencode", model: "test/reasoner" },
      profiles: { careful: { reasoningEffort: "high" } },
    }),
    { createPath: true },
  );
  const skills = `${root}/config/opencode/skills`;
  await mkdir(path.dirname(skills), { recursive: true });
  await cp(Bun.fileURLToPath(new URL("../../skills", import.meta.url)), `${root}/release`, {
    recursive: true,
  });
  await symlink(`${root}/release`, skills);
  await Bun.write(`${root}/upstream/code-review/SKILL.md`, "upstream\n", { createPath: true });
  await mkdir(`${root}/home/.agents/skills`, { recursive: true });
  await symlink(`${root}/upstream/code-review`, `${root}/home/.agents/skills/code-review`);

  expect((await run(["project", "register"])).code).toBe(0);
  await Bun.write(`${root}/plan.json`, JSON.stringify(plan));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function register() {
  const registered = await run(["source", "register", "--file", `${root}/plan.json`]);
  expect(registered.code, registered.stderr).toBe(0);
  return z.object({ data: z.object({ id: z.string() }) }).parse(registered.output).data.id;
}

async function herdrState() {
  return z
    .object({
      workspaces: z.array(z.looseObject({ workspace_id: z.string(), label: z.string() })),
      agents: z.array(
        z.object({
          name: z.string(),
          paneId: z.string(),
          kind: z.string(),
          args: z.array(z.string()),
        }),
      ),
      plugins: z.array(z.object({ id: z.string(), root: z.string() })),
      tabs: z.array(z.object({ workspaceId: z.string(), label: z.string() })),
    })
    .parse(await Bun.file(`${root}/herdr-state.json`).json());
}

async function herdrCalls() {
  const file = Bun.file(`${root}/herdr-calls.jsonl`);
  if (!(await file.exists())) return [];
  return (await file.text())
    .trim()
    .split("\n")
    .map((line) => z.array(z.string()).parse(JSON.parse(line)).slice(0, 2).join(" "));
}

async function setHerdr(change: Record<string, unknown>) {
  const file = Bun.file(`${root}/herdr-state.json`);
  const current: object = (await file.exists()) ? z.looseObject({}).parse(await file.json()) : {};
  await Bun.write(file, JSON.stringify({ ...current, ...change }));
}

async function checkoutFiles() {
  return (await git("status", "--porcelain", "--ignored")).split("\n").toSorted();
}

const launchOutput = z.object({
  data: z.object({
    brief: z.string(),
    name: z.string(),
    attempt: z.number(),
    paneId: z.string(),
    worktreePath: z.string().nullable(),
    branch: z.string().nullable(),
  }),
});

test("herdr install writes one stable manifest in device state and links it once", async () => {
  const first = await run(["herdr", "install"]);
  expect(first).toMatchObject({ code: 0, output: { reason: "herdr_plugin_linked" } });
  const manifest = await Bun.file(`${root}/state/operator/herdr-plugin/herdr-plugin.toml`).text();
  expect(Bun.TOML.parse(manifest)).toMatchObject({
    id: "operator",
    events: [
      { on: "worktree.created", command: ["operator", "herdr", "event", "--json"] },
      { on: "pane.exited", command: ["operator", "herdr", "event", "--json"] },
      { on: "pane.closed", command: ["operator", "herdr", "event", "--json"] },
      { on: "pane.agent_status_changed", command: ["operator", "herdr", "event", "--json"] },
    ],
  });
  expect(manifest).not.toContain(cli);
  expect(await run(["herdr", "install"])).toMatchObject({
    code: 0,
    output: { reason: "herdr_plugin_unchanged" },
  });
  expect((await herdrState()).plugins).toEqual([
    { id: "operator", root: `${root}/state/operator/herdr-plugin` },
  ]);
});

test("herdr install never replaces an unrecorded plugin with the same id", async () => {
  await setHerdr({ plugins: [{ id: "operator", root: `${root}/someone-else` }] });
  expect(await run(["herdr", "install"])).toMatchObject({
    code: 3,
    output: { reason: "herdr_plugin_conflict" },
  });
  expect((await herdrState()).plugins).toEqual([{ id: "operator", root: `${root}/someone-else` }]);
  expect(await herdrCalls()).not.toContain("plugin unlink");
  expect(await Bun.file(`${root}/state/operator/herdr-plugin/herdr-plugin.toml`).exists()).toBe(
    false,
  );
});

test("read-only report work gets a tab in the project workspace and a device-state brief", async () => {
  await setHerdr({
    workspaces: [
      {
        workspace_id: "w9",
        label: "one",
        worktree: { checkout_path: checkout, is_linked_worktree: false },
      },
    ],
  });
  expect((await run(["herdr", "install"])).code).toBe(0);
  const source = await register();
  const before = await checkoutFiles();
  const launched = await run(["dispatch", "--source", source, "--assignment", "investigate"]);
  expect(launched.code, launched.stderr).toBe(0);
  const data = launchOutput.parse(launched.output).data;
  expect(launched.output).toMatchObject({
    reason: "worker_launched",
    data: {
      attempt: 1,
      name: "report-one-11-investigate",
      host: "opencode",
      model: "test/reasoner",
      reasoningEffort: "medium",
      workspaceId: "w9",
      worktreePath: null,
      branch: null,
      release: { version: expect.any(String) as unknown },
      skills: expect.arrayContaining([
        { name: "worker-agent", identity: expect.any(String) as unknown },
      ]) as unknown,
    },
  });
  expect(path.isAbsolute(data.brief)).toBe(true);
  expect(data.brief.startsWith(`${root}/state/operator/projects/example/one/`)).toBe(true);
  const brief = await Bun.file(data.brief).text();
  expect(brief).toContain("Read the module and report the gaps.");
  expect(brief).toContain(`controlling checkout \`${checkout}\``);
  expect(brief).not.toContain(data.name);
  expect(brief).not.toContain(data.paneId);
  const state = await herdrState();
  expect(state.workspaces).toHaveLength(1);
  expect(state.agents).toEqual([
    {
      name: "report-one-11-investigate",
      paneId: data.paneId,
      kind: "opencode",
      args: ["mini", "--model", "test/reasoner#medium"],
    },
  ]);
  const prompt = (await Bun.file(`${root}/herdr-calls.jsonl`).text())
    .split("\n")
    .find((line) => line.startsWith('["agent","prompt"'));
  expect(prompt).toContain(`Read ${data.brief} and follow it.`);
  expect(await checkoutFiles()).toEqual(before);
  expect(await run(["next"])).toMatchObject({
    output: {
      data: {
        sources: [
          {
            waits: expect.arrayContaining([
              expect.objectContaining({
                assignment: "investigate",
                reason: "assignment_active",
                launch: expect.objectContaining({
                  attempt: 1,
                  state: "running",
                  paneId: data.paneId,
                }) as unknown,
              }) as unknown,
            ]) as unknown,
          },
        ],
      },
    },
  });
});

test("a workspace that Herdr gives no checkout is the project workspace when its panes are in the checkout", async () => {
  await setHerdr({
    workspaces: [
      { workspace_id: "w8", label: "notes" },
      { workspace_id: "w9", label: "one" },
    ],
    tabs: [
      { workspaceId: "w8", tabId: "w8:t1", paneId: "w8:p1", label: "1", cwd: root },
      { workspaceId: "w9", tabId: "w9:t1", paneId: "w9:p1", label: "1", cwd: checkout },
    ],
  });
  expect((await run(["herdr", "install"])).code).toBe(0);
  const source = await register();
  const launched = await run(["dispatch", "--source", source, "--assignment", "investigate"]);
  expect(launched.code, launched.stderr).toBe(0);
  expect(launched.output).toMatchObject({ data: { workspaceId: "w9" } });
  expect((await herdrState()).workspaces.map((row) => row.workspace_id)).toEqual(["w8", "w9"]);
  expect(await herdrCalls()).not.toContain("workspace create");
});

test("a new project workspace tab gets the repository name, and a new worktree tab the launch name", async () => {
  expect((await run(["herdr", "install"])).code).toBe(0);
  const source = await register();
  const launched = await run(["dispatch", "--source", source, "--assignment", "implement"]);
  expect(launched.code, launched.stderr).toBe(0);
  const state = await herdrState();
  expect(state.workspaces.map((row) => [row.workspace_id, row.label])).toEqual([
    ["w1", "one"],
    ["w3", "pr-one-12-implement"],
  ]);
  expect(state.tabs).toEqual([
    { workspaceId: "w1", label: "one" },
    { workspaceId: "w3", label: "pr-one-12-implement" },
  ]);
});

test("worktree work prepares the new Herdr worktree before the agent starts", async () => {
  expect((await run(["herdr", "install"])).code).toBe(0);
  // A package's own environment file inside an ignored dependency folder is not a project input.
  await Bun.write(`${checkout}/node_modules/pkg/.env.local`, "PACKAGE=1\n", { createPath: true });
  const source = await register();
  const launched = await run(["dispatch", "--source", source, "--assignment", "implement"]);
  expect(launched.code, launched.stderr).toBe(0);
  const data = launchOutput.parse(launched.output).data;
  expect(data).toMatchObject({
    name: "pr-one-12-implement",
    branch: "task/12-implement",
    worktreePath: `${root}/herdr-home/worktrees/pr-one-12-implement`,
  });
  expect(launched.output).toMatchObject({
    data: {
      reasoningEffort: "high",
      profile: "careful",
      preparation: expect.stringContaining("Copied 2") as unknown,
    },
  });
  const worktree = data.worktreePath ?? "";
  expect(await Bun.file(`${worktree}/.env.local`).text()).toBe("TOKEN=local\n");
  expect(await Bun.file(`${worktree}/apps/web/.env.development.local`).text()).toBe("NESTED=1\n");
  expect(await Bun.file(`${worktree}/.env`).exists()).toBe(false);
  expect(await Bun.file(`${worktree}/.env.local.backup`).exists()).toBe(false);
  expect(await Bun.file(`${worktree}/node_modules`).exists()).toBe(false);
  expect(data.brief.startsWith(worktree)).toBe(false);
  expect(await Bun.file(data.brief).text()).toContain(`branch \`task/12-implement\``);
  const calls = await herdrCalls();
  expect(calls.indexOf("worktree create")).toBeLessThan(calls.indexOf("agent start"));
  expect((await herdrState()).workspaces.map((row) => row.label)).toEqual([
    "one",
    "pr-one-12-implement",
  ]);
});

test("preparation preserves existing files and refuses linked environment files", async () => {
  expect((await run(["herdr", "install"])).code).toBe(0);
  await symlink(`${root}/plan.json`, `${checkout}/.env.test.local`);
  const worktree = `${root}/other-worktree`;
  await git("worktree", "add", "-q", "-b", "outside", worktree);
  await Bun.write(`${worktree}/.env.local`, "TOKEN=worktree\n");
  const hook = await exec(
    [
      "env",
      "HERDR_PLUGIN_EVENT=worktree.created",
      `HERDR_PLUGIN_EVENT_JSON=${JSON.stringify({ event: "worktree_created", data: { worktree: { path: worktree } } })}`,
      process.execPath,
      cli,
      "herdr",
      "event",
      "--json",
    ],
    worktree,
  );
  expect(hook.code, hook.stderr).toBe(0);
  expect(JSON.parse(hook.stdout)).toMatchObject({
    reason: "worktree_prepared",
    data: {
      detail: expect.stringContaining(
        "Copied 1 environment files, preserved 1, refused 1",
      ) as unknown,
    },
  });
  expect(await Bun.file(`${worktree}/.env.local`).text()).toBe("TOKEN=worktree\n");
  expect(await Bun.file(`${worktree}/.env.test.local`).exists()).toBe(false);
  expect(await Bun.file(`${worktree}/apps/web/.env.development.local`).text()).toBe("NESTED=1\n");
});

test("a worktree of an unregistered repository is not prepared", async () => {
  const other = `${root}/other`;
  await mkdir(other);
  await exec(["git", "init", "-q", "-b", "main"], other);
  await exec(["git", "commit", "-q", "--allow-empty", "-m", "x"], other);
  await exec(["git", "worktree", "add", "-q", "-b", "x", `${root}/other-wt`], other);
  await Bun.write(`${other}/.env.local`, "SECRET=1\n");
  const hook = await exec(
    [
      "env",
      "HERDR_PLUGIN_EVENT=worktree.created",
      `HERDR_PLUGIN_EVENT_JSON=${JSON.stringify({ event: "worktree_created", data: { worktree: { path: `${root}/other-wt` } } })}`,
      process.execPath,
      cli,
      "herdr",
      "event",
      "--json",
    ],
    root,
  );
  expect(JSON.parse(hook.stdout)).toMatchObject({ reason: "worktree_unregistered" });
  expect(await Bun.file(`${root}/other-wt/.env.local`).exists()).toBe(false);
});

test("collisions get a suffix and leave unrecorded branches, agents, and tabs untouched", async () => {
  expect((await run(["herdr", "install"])).code).toBe(0);
  await git("branch", "task/12-implement");
  const branchBefore = await git("rev-parse", "task/12-implement");
  await setHerdr({
    agents: [{ name: "pr-one-12-implement-2", paneId: "x:p1", kind: "claude", args: [] }],
  });
  const source = await register();
  const launched = await run(["dispatch", "--source", source, "--assignment", "implement"]);
  expect(launched.code, launched.stderr).toBe(0);
  expect(launchOutput.parse(launched.output).data).toMatchObject({
    name: "pr-one-12-implement-3",
    branch: "task/12-implement-3",
  });
  expect(await git("rev-parse", "task/12-implement")).toBe(branchBefore);
  expect((await herdrState()).agents[0]).toEqual({
    name: "pr-one-12-implement-2",
    paneId: "x:p1",
    kind: "claude",
    args: [],
  });
});

test("refusals before reservation make no Herdr effect and no state change", async () => {
  const source = await register();
  const database = `${root}/state/operator/operator.sqlite`;
  const before = await Bun.file(database).arrayBuffer();
  expect(await run(["dispatch", "--source", source, "--assignment", "follow"])).toMatchObject({
    code: 4,
    output: { reason: "assignment_not_dispatchable" },
  });
  expect(await herdrCalls()).toEqual([]);
  expect(await run(["dispatch", "--source", source, "--assignment", "investigate"])).toMatchObject({
    code: 3,
    output: { reason: "herdr_plugin_missing" },
  });
  expect(await herdrCalls()).toEqual(["plugin list"]);
  expect(await Bun.file(database).arrayBuffer()).toEqual(before);
  expect(await Array.fromAsync(new Bun.Glob("**/brief.md").scan({ cwd: `${root}/state` }))).toEqual(
    [],
  );
});

test("a failed launch stays visible, and a replacement resolves current settings", async () => {
  expect((await run(["herdr", "install"])).code).toBe(0);
  const source = await register();
  await setHerdr({ fail: { "agent start": "agent_not_ready: trust prompt" } });
  const failed = await run(["dispatch", "--source", source, "--assignment", "implement"]);
  expect(failed).toMatchObject({ code: 1, output: { reason: "launch_failed" } });
  expect(failed.stderr).toContain("trust prompt");
  const next = await run(["next"]);
  expect(next.output).toMatchObject({
    data: {
      sources: [
        {
          actions: [
            {
              assignment: "implement",
              action: "replace_worker",
              reason: "launch_failed",
              launch: {
                attempt: 1,
                state: "failed",
                worktreePath: `${root}/herdr-home/worktrees/pr-one-12-implement`,
                failure: { reason: "herdr_failed" },
              },
            },
            { assignment: "investigate", action: "ready_assignment" },
          ].reverse(),
        },
      ],
    },
  });
  await Bun.write(
    `${root}/config/operator/config.json`,
    JSON.stringify({
      superAgent: { host: "opencode", model: "test/reasoner" },
      profiles: { careful: { model: "test/writer", reasoningEffort: "medium" } },
    }),
  );
  await setHerdr({ fail: {} });
  const replaced = await run(["dispatch", "--source", source, "--assignment", "implement"]);
  expect(replaced.code, replaced.stderr).toBe(0);
  expect(replaced.output).toMatchObject({
    data: {
      attempt: 2,
      name: "pr-one-12-implement-2",
      model: "test/writer",
      worktreePath: `${root}/herdr-home/worktrees/pr-one-12-implement`,
      branch: "task/12-implement",
      preparation: expect.stringContaining("Copied 2") as unknown,
    },
  });
  expect(await herdrCalls()).toContain("worktree open");
  const shown = await run(["source", "show", "--source", source]);
  expect(shown.output).toMatchObject({
    data: {
      launches: [
        { attempt: 1, state: "failed", model: "test/reasoner", reasoningEffort: "high" },
        { attempt: 2, state: "running", model: "test/writer", reasoningEffort: "medium" },
      ],
    },
  });
});

async function launchedRows(source: string) {
  const shown = await run(["source", "show", "--source", source]);
  return z
    .object({
      data: z.object({
        launches: z.array(
          z.looseObject({
            attempt: z.number(),
            state: z.string(),
            worktreePath: z.string().nullable(),
            failureReason: z.string().nullable(),
          }),
        ),
      }),
    })
    .parse(shown.output).data.launches;
}

/** Herdr runs no hook, so dispatch waits for the worktree preparation until it is stopped. */
async function stuckDispatch(source: string) {
  await setHerdr({ skipHooks: true });
  const child = Bun.spawn(
    [process.execPath, cli, "dispatch", "--source", source, "--assignment", "implement", "--json"],
    { cwd: checkout, env: environment(), stdout: "pipe", stderr: "pipe" },
  );
  const deadline = Date.now() + 20000;
  while (((await launchedRows(source)).at(-1)?.worktreePath ?? null) === null) {
    expect(Date.now()).toBeLessThan(deadline);
    await Bun.sleep(100);
  }
  return child;
}

function nextAction(assignment: string) {
  return run(["next"]).then((next) =>
    z
      .object({
        data: z.object({
          sources: z.array(
            z.object({
              actions: z.array(z.looseObject({ assignment: z.string().optional() })),
              waits: z.array(z.looseObject({ assignment: z.string().optional() })),
            }),
          ),
        }),
      })
      .parse(next.output)
      .data.sources.flatMap((row) => [...row.actions, ...row.waits])
      .find((row) => row.assignment === assignment),
  );
}

test("a killed dispatch is abandoned, and the replacement prepares the reopened worktree", async () => {
  expect((await run(["herdr", "install"])).code).toBe(0);
  const source = await register();
  const child = await stuckDispatch(source);
  expect(await nextAction("implement")).toMatchObject({
    action: "wait",
    reason: "launch_starting",
  });
  child.kill("SIGKILL");
  await child.exited;
  expect(await nextAction("implement")).toMatchObject({
    action: "replace_worker",
    reason: "launch_abandoned",
    launch: { attempt: 1, state: "starting" },
  });
  const worktree = `${root}/herdr-home/worktrees/pr-one-12-implement`;
  expect(await Bun.file(`${worktree}/.env.local`).exists()).toBe(false);
  await setHerdr({ skipHooks: false });
  const replaced = await run(["dispatch", "--source", source, "--assignment", "implement"]);
  expect(replaced.code, replaced.stderr).toBe(0);
  expect(replaced.output).toMatchObject({
    data: {
      attempt: 2,
      worktreePath: worktree,
      preparation: expect.stringContaining("Copied 2") as unknown,
    },
  });
  expect(await Bun.file(`${worktree}/.env.local`).text()).toBe("TOKEN=local\n");
  expect(await launchedRows(source)).toMatchObject([
    { attempt: 1, state: "failed", failureReason: "launch_abandoned" },
    { attempt: 2, state: "running" },
  ]);
});

test("a stop signal during dispatch records the launch as failed", async () => {
  expect((await run(["herdr", "install"])).code).toBe(0);
  const source = await register();
  const child = await stuckDispatch(source);
  child.kill("SIGTERM");
  expect(await child.exited).toBe(143);
  expect(await launchedRows(source)).toMatchObject([
    { attempt: 1, state: "failed", failureReason: "launch_stopped" },
  ]);
  expect(await nextAction("implement")).toMatchObject({
    action: "replace_worker",
    reason: "launch_failed",
  });
});

test("a replacement prepares a reopened worktree whose preparation failed", async () => {
  await Bun.write(`${checkout}/bun.lock`, "not a lockfile\n");
  await git("add", "bun.lock");
  await git("commit", "-q", "-m", "broken lockfile");
  expect((await run(["herdr", "install"])).code).toBe(0);
  const source = await register();
  const failed = await run(["dispatch", "--source", source, "--assignment", "implement"]);
  expect(failed).toMatchObject({ code: 1, output: { reason: "launch_failed" } });
  expect(failed.stderr).toContain("worktree_setup_failed");
  expect(await herdrCalls()).not.toContain("agent start");
  const worktree = `${root}/herdr-home/worktrees/pr-one-12-implement`;
  // The person repairs the worktree. The replacement reopens it and prepares it again.
  await rm(`${worktree}/bun.lock`);
  const replaced = await run(["dispatch", "--source", source, "--assignment", "implement"]);
  expect(replaced.code, replaced.stderr).toBe(0);
  expect(replaced.output).toMatchObject({
    data: {
      attempt: 2,
      worktreePath: worktree,
      preparation: expect.stringContaining("No Bun lockfile") as unknown,
    },
  });
  expect(await herdrCalls()).toContain("worktree open");
});

test("a pane that ends during the start interrupts the launch", async () => {
  expect((await run(["herdr", "install"])).code).toBe(0);
  const source = await register();
  await setHerdr({ exitOnPrompt: true });
  const started = await run(["dispatch", "--source", source, "--assignment", "investigate"]);
  expect(started).toMatchObject({ code: 1, output: { reason: "launch_interrupted" } });
  expect(await nextAction("investigate")).toMatchObject({
    action: "replace_worker",
    reason: "worker_interrupted",
    launch: { attempt: 1, state: "interrupted", failure: { reason: "pane_ended" } },
  });
});

test("dispatch outside a Herdr session and with a stale plugin refuses before any write", async () => {
  expect((await run(["herdr", "install"])).code).toBe(0);
  const source = await register();
  const database = `${root}/state/operator/operator.sqlite`;
  const before = await Bun.file(database).arrayBuffer();
  await rm(`${root}/herdr-calls.jsonl`, { force: true });
  const outside = await exec([
    "env",
    "-u",
    "HERDR_SOCKET_PATH",
    process.execPath,
    cli,
    "dispatch",
    "--source",
    source,
    "--assignment",
    "investigate",
    "--json",
  ]);
  expect(outside.code).toBe(3);
  expect(JSON.parse(outside.stdout)).toMatchObject({ reason: "herdr_session_required" });
  expect(await herdrCalls()).toEqual([]);
  const manifest = `${root}/state/operator/herdr-plugin/herdr-plugin.toml`;
  await Bun.write(manifest, `${await Bun.file(manifest).text()}# changed\n`);
  expect(await run(["dispatch", "--source", source, "--assignment", "investigate"])).toMatchObject({
    code: 3,
    output: { reason: "herdr_plugin_outdated" },
  });
  expect(await herdrCalls()).toEqual(["plugin list"]);
  expect(await Bun.file(database).arrayBuffer()).toEqual(before);
});

test("a Herdr event on a device without state is ignored and succeeds", async () => {
  const event = await exec([
    "env",
    `XDG_STATE_HOME=${root}/no-state`,
    "HERDR_PLUGIN_EVENT=pane.agent_status_changed",
    `HERDR_PLUGIN_EVENT_JSON=${JSON.stringify({ event: "pane_agent_status_changed", data: { pane_id: "p1", agent_status: "idle" } })}`,
    process.execPath,
    cli,
    "herdr",
    "event",
    "--json",
  ]);
  expect(event.code, event.stderr).toBe(0);
  expect(JSON.parse(event.stdout)).toMatchObject({ reason: "herdr_event_ignored" });
  expect(await Bun.file(`${root}/no-state/operator/operator.sqlite`).exists()).toBe(false);
});

test("a pane exit interrupts its running launch, and activity never completes it", async () => {
  expect((await run(["herdr", "install"])).code).toBe(0);
  const source = await register();
  const launched = launchOutput.parse(
    (await run(["dispatch", "--source", source, "--assignment", "investigate"])).output,
  ).data;
  const status = await exec([
    "env",
    "HERDR_PLUGIN_EVENT=pane.agent_status_changed",
    `HERDR_PLUGIN_EVENT_JSON=${JSON.stringify({ event: "pane_agent_status_changed", data: { pane_id: launched.paneId, agent_status: "done" } })}`,
    process.execPath,
    cli,
    "herdr",
    "event",
    "--json",
  ]);
  expect(JSON.parse(status.stdout)).toMatchObject({ reason: "herdr_activity_observed" });
  // A done worker with no result needs attention, and its launch stays running.
  expect((await run(["next"])).output).toMatchObject({
    data: {
      sources: [
        {
          actions: expect.arrayContaining([
            expect.objectContaining({
              assignment: "investigate",
              action: "worker_attention",
              reason: "worker_idle",
              launch: expect.objectContaining({
                state: "running",
                observedActivity: expect.objectContaining({ state: "done" }) as unknown,
              }) as unknown,
            }) as unknown,
          ]) as unknown,
        },
      ],
    },
  });
  // Attention never revives or replaces a live worker.
  expect(await run(["dispatch", "--source", source, "--assignment", "investigate"])).toMatchObject({
    code: 4,
    output: { reason: "assignment_not_dispatchable" },
  });
  // Another Herdr server can reuse the same pane identifier.
  const foreign = await exec([
    "env",
    "HERDR_SOCKET_PATH=/elsewhere.sock",
    "HERDR_PLUGIN_EVENT=pane.exited",
    `HERDR_PLUGIN_EVENT_JSON=${JSON.stringify({ event: "pane_exited", data: { pane_id: launched.paneId } })}`,
    process.execPath,
    cli,
    "herdr",
    "event",
    "--json",
  ]);
  expect(JSON.parse(foreign.stdout)).toMatchObject({ data: { launches: [] } });
  await exec(["herdr", "pane", "exit", launched.paneId, "w1"]);
  expect((await run(["next"])).output).toMatchObject({
    data: {
      sources: [
        {
          actions: expect.arrayContaining([
            expect.objectContaining({
              assignment: "investigate",
              action: "replace_worker",
              reason: "worker_interrupted",
              launch: expect.objectContaining({ state: "interrupted" }) as unknown,
            }) as unknown,
          ]) as unknown,
        },
      ],
    },
  });
});
