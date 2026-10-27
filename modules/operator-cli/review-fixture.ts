import { Database } from "bun:sqlite";
import { expect } from "bun:test";
// Bun has no temporary-directory, symlink, permission, or recursive copy API.
import { chmod, cp, mkdir, mkdtemp, realpath, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { z } from "zod";
import { Environment } from "../environment/main.ts";
import { fakeGithubScript } from "./fake-github.ts";
import { fakeHerdrScript } from "./fake-herdr.ts";

const cli = Bun.fileURLToPath(new URL("../../cli.ts", import.meta.url));
const gitEnv = {
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "Fixture",
  GIT_AUTHOR_EMAIL: "fixture@example.com",
  GIT_COMMITTER_NAME: "Fixture",
  GIT_COMMITTER_EMAIL: "fixture@example.com",
};
const claude = `#!${process.execPath}
for await (const chunk of Bun.stdin.stream().pipeThrough(new TextDecoderStream())) {
 for (const line of chunk.trim().split("\\n")) {
  const message=JSON.parse(line);
  if(message.type === "control_request") console.log(JSON.stringify({type:"control_response",response:{subtype:"success",request_id:message.request_id,response:{models:[{value:"precise-model",supportsEffort:true,supportedEffortLevels:["medium","high"]}],commands:[],agents:[]}}}));
 }
}
`;
const opencode = `#!${process.execPath}\nconst dir=decodeURIComponent(process.argv[4].split("=")[1]);\nconsole.log(JSON.stringify({location:{directory:dir},data:[{providerID:"test",id:"reasoner",enabled:true,variants:[{id:"medium"},{id:"high"}]}]}));\n`;

export const url = "https://github.com/example/one/pull/7";
const requestSchema = z.looseObject({
  id: z.string(),
  state: z.string(),
  draft: z.string(),
  brief: z.string(),
  reviewer: z
    .looseObject({ worktreePath: z.string().nullable(), branch: z.string().nullable() })
    .nullable(),
});
const stateSchema = z.looseObject({
  pulls: z.array(z.looseObject({ number: z.number() })),
  posted: z
    .array(z.looseObject({ event: z.string(), body: z.string(), commit_id: z.string() }))
    .optional(),
  threadCalls: z
    .array(z.looseObject({ kind: z.string(), thread: z.string(), body: z.string().optional() }))
    .optional(),
});

/**
 * An isolated device with a registered project whose origin is a local bare repository. The PR
 * head exists only as `refs/pull/7/head` there, as GitHub keeps it. Real Git and SQLite, the
 * controlled `herdr` and `gh`, and both controlled hosts. It is not live integration evidence.
 */
export async function reviewDevice(host: "opencode" | "claude-code" = "opencode") {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "operator-rounds-")));
  const checkout = `${root}/checkout`;
  const remote = `${root}/remote.git`;

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

  async function exec(args: string[], cwd: string) {
    const child = Bun.spawn(args, { cwd, env: environment(), stdout: "pipe", stderr: "pipe" });
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    return { code, stdout, stderr };
  }

  /** Review commands run from the device root, which is no checkout. */
  async function run(args: string[], cwd = root) {
    const result = await exec([process.execPath, cli, ...args, "--json"], cwd);
    return {
      code: result.code,
      output: z.looseObject({}).parse(JSON.parse(result.stdout)),
      stderr: result.stderr,
    };
  }

  async function git(cwd: string, ...args: string[]) {
    const result = await exec(["git", ...args], cwd);
    expect(result.code, result.stderr).toBe(0);
    return result.stdout.trim();
  }

  async function tool(name: string, script: string) {
    await Bun.write(`${root}/tools/${name}`, script, { createPath: true });
    await chmod(`${root}/tools/${name}`, 0o755);
  }

  async function github(change: object) {
    const file = Bun.file(`${root}/github.json`);
    const current: object = (await file.exists()) ? z.looseObject({}).parse(await file.json()) : {};
    await Bun.write(file, JSON.stringify({ ...current, ...change }));
  }

  async function githubState() {
    return stateSchema.parse(await Bun.file(`${root}/github.json`).json());
  }

  /** Changes PR #7 in the controlled GitHub state. */
  async function pullRequest(change: object) {
    const state = await githubState();
    await github({
      pulls: state.pulls.map((pull) => (pull.number === 7 ? { ...pull, ...change } : pull)),
    });
  }

  /** Commits on top of `base` and publishes the commit as the PR head. */
  async function push(base: string, file: string) {
    await git(checkout, "switch", "-q", "--detach", base);
    await Bun.write(`${checkout}/${file}`, `${file}\n`);
    await git(checkout, "add", ".");
    await git(checkout, "commit", "-q", "-m", file);
    const commit = await git(checkout, "rev-parse", "HEAD");
    await git(checkout, "push", "-q", "--force", remote, "HEAD:refs/pull/7/head");
    await git(checkout, "switch", "-q", "main");
    await pullRequest({ head: commit });
    return commit;
  }

  async function herdrCalls() {
    const file = Bun.file(`${root}/herdr-calls.jsonl`);
    if (!(await file.exists())) return [];
    return (await file.text())
      .trim()
      .split("\n")
      .map((line) => z.array(z.string()).parse(JSON.parse(line)));
  }

  async function prompts() {
    return (await herdrCalls())
      .filter((call) => call[0] === "agent" && call[1] === "prompt")
      .map((call) => call[3] ?? "");
  }

  async function add() {
    const added = await run(["review", "add", url]);
    expect(added.code, added.stderr).toBe(0);
    return z.object({ data: requestSchema }).parse(added.output).data;
  }

  async function draft(file: string, commit: string, change: object = {}) {
    await Bun.write(
      file,
      JSON.stringify({
        reviewedCommit: commit,
        summary: "The change keeps its value in one module.",
        checks: [{ kind: "test", command: "bun test feature.test.ts", exitCode: 0 }],
        ...change,
      }),
    );
  }

  async function next() {
    const read = await run(["review", "next"]);
    return z.object({ data: z.object({ requests: z.array(z.looseObject({})) }) }).parse(read.output)
      .data.requests;
  }

  /** Writes recorded state directly, only to move the clock that a test cannot wait for. */
  function sql(statement: string, ...values: string[]) {
    using db = new Database(`${root}/state/operator/operator.sqlite`);
    db.query(statement).run(...values);
  }

  await mkdir(checkout);
  await git(root, "init", "-q", "--bare", remote);
  await git(checkout, "init", "-q", "-b", "main");
  await git(checkout, "remote", "add", "origin", "https://github.com/example/one.git");
  await Bun.write(`${checkout}/README.md`, "fixture\n");
  await git(checkout, "add", ".");
  await git(checkout, "commit", "-q", "-m", "fixture");
  const base = await git(checkout, "rev-parse", "HEAD");
  await git(checkout, "push", "-q", remote, "main");
  await tool("herdr", fakeHerdrScript(root));
  await tool("gh", fakeGithubScript(root));
  await symlink(cli, `${root}/tools/operator`);
  await tool("opencode", opencode);
  await tool("claude", claude);
  const model = host === "opencode" ? "test/reasoner" : "precise-model";
  await Bun.write(
    `${root}/config/operator/config.json`,
    JSON.stringify({ superAgent: { host, model }, workerAgent: { host, model } }),
    { createPath: true },
  );
  await cp(Bun.fileURLToPath(new URL("../../skills", import.meta.url)), `${root}/release`, {
    recursive: true,
  });
  const skills =
    host === "opencode" ? `${root}/config/opencode/skills` : `${root}/home/.claude/skills`;
  await mkdir(path.dirname(skills), { recursive: true });
  await symlink(`${root}/release`, skills);
  const upstream = host === "opencode" ? `${root}/home/.agents/skills` : skills;
  await Bun.write(`${root}/upstream/code-review/SKILL.md`, "upstream\n", { createPath: true });
  await mkdir(upstream, { recursive: true });
  await symlink(`${root}/upstream/code-review`, `${upstream}/code-review`);
  expect((await run(["project", "register"], checkout)).code).toBe(0);
  expect((await run(["herdr", "install"], checkout)).code).toBe(0);
  // Fetches from the GitHub remote reach the local bare repository after registration.
  await git(checkout, "config", `url.${remote}.insteadOf`, "https://github.com/example/one.git");
  await github({
    pulls: [{ number: 7, url, state: "OPEN", author: "author", files: ["feature.ts"] }],
  });
  const head = await push(base, "feature.ts");

  /** Changes the controlled Herdr state, for example to delay its answers. */
  async function herdrState(change: object) {
    const file = Bun.file(`${root}/herdr-state.json`);
    const current: object = (await file.exists()) ? z.looseObject({}).parse(await file.json()) : {};
    await Bun.write(file, JSON.stringify({ ...current, ...change }));
  }

  /** Runs the controlled Herdr, for example to end a pane the way a host exit does. */
  async function herdr(...args: string[]) {
    const result = await exec(["herdr", ...args], root);
    expect(result.code, result.stderr).toBe(0);
  }

  return {
    root,
    checkout,
    herdr,
    herdrState,
    head,
    run,
    git,
    github,
    githubState,
    pullRequest,
    push,
    herdrCalls,
    prompts,
    add,
    draft,
    next,
    sql,
  };
}
