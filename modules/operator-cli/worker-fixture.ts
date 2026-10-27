import { expect } from "bun:test";
// Bun has no temporary-directory, symlink, permission, or recursive copy API.
import { chmod, cp, mkdir, mkdtemp, realpath, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { z } from "zod";
import { Environment } from "../environment/main.ts";
import { fakeHerdrScript } from "./fake-herdr.ts";
import { fakeGithubScript } from "./fake-github.ts";

const cli = Bun.fileURLToPath(new URL("../../cli.ts", import.meta.url));
const gitEnv = {
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "Fixture",
  GIT_AUTHOR_EMAIL: "fixture@example.com",
  GIT_COMMITTER_NAME: "Fixture",
  GIT_COMMITTER_EMAIL: "fixture@example.com",
};

// The Claude Code host answers only the model metadata request.
const fakeClaude = `#!${process.execPath}
for await (const chunk of Bun.stdin.stream().pipeThrough(new TextDecoderStream())) {
 for (const line of chunk.trim().split("\\n")) {
  const message=JSON.parse(line);
  if(message.type === "control_request") console.log(JSON.stringify({type:"control_response",response:{subtype:"success",request_id:message.request_id,response:{models:[{value:"precise-model",supportsEffort:true,supportedEffortLevels:["medium","high"]}],commands:[],agents:[]}}}));
 }
}
`;
const fakeOpencode = `#!${process.execPath}\nconst dir=decodeURIComponent(process.argv[4].split("=")[1]);\nconsole.log(JSON.stringify({location:{directory:dir},data:[{providerID:"test",id:"reasoner",enabled:true,variants:[{id:"medium"},{id:"high"}]},{providerID:"test",id:"writer",enabled:true,variants:[{id:"medium"}]}]}));\n`;

/**
 * An isolated device with real Git and SQLite, the controlled Herdr, and both controlled hosts.
 * The SuperAgent runs in pane `super:p0`. A WorkerAgent command runs with its launch's pane.
 * With `github`, the controlled GitHub tool answers PR reads and merges from `github.json`.
 */
export async function workerDevice(options: { github?: boolean } = {}) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "operator-reports-")));

  function environment(pane = "super:p0", socket = `${root}/herdr.sock`) {
    return Environment.child({
      ...gitEnv,
      HOME: `${root}/home`,
      XDG_CONFIG_HOME: `${root}/config`,
      XDG_STATE_HOME: `${root}/state`,
      BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0",
      HERDR_SOCKET_PATH: socket,
      HERDR_PANE_ID: pane,
      PATH: `${root}/tools:${Environment.read().PATH}`,
    });
  }

  async function exec(args: string[], cwd: string, env = environment()) {
    const child = Bun.spawn(args, { cwd, env, stdout: "pipe", stderr: "pipe" });
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    return { code, stdout, stderr };
  }

  async function tool(name: string, script: string) {
    await Bun.write(`${root}/tools/${name}`, script, { createPath: true });
    await chmod(`${root}/tools/${name}`, 0o755);
  }

  /** A main checkout with a GitHub remote, committed files, and ignored local inputs. */
  async function checkout(name: string, repository: string) {
    const directory = `${root}/${name}`;
    await mkdir(directory);
    function git(...args: string[]) {
      return exec(["git", ...args], directory);
    }
    await git("init", "-q", "-b", "main");
    await git("remote", "add", "origin", `https://github.com/${repository}.git`);
    await Bun.write(`${directory}/package.json`, JSON.stringify({ name, private: true }));
    await Bun.write(`${directory}/.gitignore`, ".env*\nnode_modules\n");
    await git("add", ".");
    await git("commit", "-q", "-m", "fixture");
    await Bun.write(`${directory}/.env.local`, "TOKEN=local\n");
    return directory;
  }

  await tool("herdr", fakeHerdrScript(root));
  // Readiness accepts only a global command that links to the running entry point.
  await symlink(cli, `${root}/tools/operator`);
  await tool(
    "gh",
    options.github === true
      ? fakeGithubScript(root)
      : `#!${process.execPath}\nprocess.exit(process.argv[2] === "auth" ? 0 : 99);\n`,
  );
  await tool("opencode", fakeOpencode);
  await tool("claude", fakeClaude);
  await Bun.write(
    `${root}/config/operator/config.json`,
    JSON.stringify({
      superAgent: { host: "opencode", model: "test/reasoner" },
      profiles: {
        careful: { reasoningEffort: "high" },
        claude: { host: "claude-code", model: "precise-model", reasoningEffort: "medium" },
      },
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

  const main = await checkout("checkout", "example/one");

  /** Run the public CLI as the SuperAgent, or in a worker pane when `pane` is set. */
  async function run(
    args: string[],
    options: { cwd?: string; pane?: string; socket?: string } = {},
  ) {
    const result = await exec(
      [process.execPath, cli, ...args, "--json"],
      options.cwd ?? main,
      environment(options.pane, options.socket),
    );
    return {
      code: result.code,
      output: z.looseObject({}).parse(JSON.parse(result.stdout)),
      stderr: result.stderr,
    };
  }

  async function register(plan: Record<string, unknown>, cwd = main) {
    const file = `${root}/plan-${crypto.randomUUID()}.json`;
    await Bun.write(file, JSON.stringify(plan));
    const registered = await run(["source", "register", "--file", file], { cwd });
    expect(registered.code, registered.stderr).toBe(0);
    return z.object({ data: z.object({ id: z.string() }) }).parse(registered.output).data.id;
  }

  async function dispatch(source: string, assignment: string, cwd = main) {
    const launched = await run(["dispatch", "--source", source, "--assignment", assignment], {
      cwd,
    });
    expect(launched.code, launched.stderr).toBe(0);
    return z
      .object({
        data: z.object({
          brief: z.string(),
          paneId: z.string(),
          name: z.string(),
          attempt: z.number(),
          worktreePath: z.string().nullable(),
        }),
      })
      .parse(launched.output).data;
  }

  async function writeJson(name: string, value: Record<string, unknown>) {
    const file = `${root}/drafts/${name}`;
    await Bun.write(file, JSON.stringify(value), { createPath: true });
    return file;
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

  /** Every next row of one assignment, across actions and waits. */
  async function next(assignment: string, cwd = main) {
    const read = await run(["next"], { cwd });
    return z
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
      .parse(read.output)
      .data.sources.flatMap((row) => [...row.actions, ...row.waits])
      .filter((row) => row.assignment === assignment);
  }

  /** Herdr runs the plugin hook for a pane event, as the real server does. */
  function event(name: string, data: Record<string, unknown>) {
    return exec(
      [
        "env",
        `HERDR_PLUGIN_EVENT=${name}`,
        `HERDR_PLUGIN_EVENT_JSON=${JSON.stringify({ event: name.replace(".", "_"), data })}`,
        process.execPath,
        cli,
        "herdr",
        "event",
        "--json",
      ],
      main,
    );
  }

  expect((await run(["project", "register"])).code).toBe(0);
  expect((await run(["herdr", "install"])).code).toBe(0);
  return {
    root,
    main,
    run,
    exec,
    checkout,
    register,
    dispatch,
    writeJson,
    herdrCalls,
    setHerdr,
    next,
    event,
  };
}
