import { afterEach, expect, test } from "bun:test";
// Bun has no temporary-directory, symlink, permission, or recursive removal API.
import { writeClaudeHookSettings } from "./command-fixture.ts";
import { chmod, cp, mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { z } from "zod";
import { Environment } from "../environment/main.ts";
import { fakeHerdrScript } from "./herdr-fixture.ts";
import { fakeGithubScript } from "./github-fixture.ts";

// Internal review is on by default, so these tests set no review setting. ADR-0020.

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

async function git(cwd: string, ...args: string[]) {
  const result = await exec(["git", ...args], cwd);
  expect(result.code, result.stderr).toBe(0);
  return result.stdout.trim();
}

async function tool(name: string, script: string) {
  await Bun.write(`${root}/tools/${name}`, script, { createPath: true });
  await chmod(`${root}/tools/${name}`, 0o755);
}

const claude = `#!${process.execPath}
for await (const chunk of Bun.stdin.stream().pipeThrough(new TextDecoderStream())) {
 for (const line of chunk.trim().split("\\n")) {
  const message=JSON.parse(line);
  if(message.type === "control_request") console.log(JSON.stringify({type:"control_response",response:{subtype:"success",request_id:message.request_id,response:{models:[{value:"precise-model",supportsEffort:true,supportedEffortLevels:["medium","high"]}],commands:[],agents:[]}}}));
 }
}
`;
const opencode = `#!${process.execPath}\nconst dir=decodeURIComponent(process.argv[4].split("=")[1]);\nconsole.log(JSON.stringify({location:{directory:dir},data:[{providerID:"test",id:"reasoner",enabled:true,variants:[{id:"medium"},{id:"high"}]}]}));\n`;

const plan = {
  trackerKey: "github:example/one#10",
  assignments: [
    {
      key: "implement",
      trackerKey: "github:example/one#12",
      instructions: "Implement the change.",
      completion: "pr",
      resources: "worktree",
      branch: "task/12-implement",
      dependencies: [],
    },
    {
      key: "second",
      trackerKey: "github:example/one#13",
      instructions: "Implement the second change.",
      completion: "pr",
      resources: "worktree",
      branch: "task/13-second",
      dependencies: [],
    },
  ],
};

async function setup(host: "opencode" | "claude-code") {
  root = await realpath(await mkdtemp(path.join(tmpdir(), "operator-pr-")));
  checkout = `${root}/checkout`;
  await mkdir(checkout);
  await git(checkout, "init", "-q", "-b", "main");
  await git(checkout, "remote", "add", "origin", "https://github.com/example/one.git");
  await Bun.write(`${checkout}/README.md`, "fixture\n");
  await git(checkout, "add", ".");
  await git(checkout, "commit", "-q", "-m", "fixture");
  await tool("herdr", fakeHerdrScript(root));
  await tool("gh", fakeGithubScript(root));
  await symlink(cli, `${root}/tools/operator`);
  await tool("opencode", opencode);
  await tool("claude", claude);
  await Bun.write(
    `${root}/config/operator/config.json`,
    JSON.stringify({
      superAgent:
        host === "opencode" ? { host, model: "test/reasoner" } : { host, model: "precise-model" },
    }),
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
  await writeClaudeHookSettings(`${root}/home`);
  expect((await run(["project", "register"])).code).toBe(0);
  expect((await run(["herdr", "install"])).code).toBe(0);
  await Bun.write(`${root}/plan.json`, JSON.stringify(plan));
  const registered = await run(["source", "register", "--file", `${root}/plan.json`]);
  return z.object({ data: z.object({ id: z.string() }) }).parse(registered.output).data.id;
}

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function dispatch(source: string, assignment = "implement") {
  const launched = await run(["dispatch", "--source", source, "--assignment", assignment]);
  expect(launched.code, launched.stderr).toBe(0);
  return z
    .object({ data: z.object({ worktreePath: z.string(), paneId: z.string(), brief: z.string() }) })
    .parse(launched.output).data;
}

type Pull = Record<string, unknown> & { number: number };
async function github(change: { pulls?: Pull[]; queue?: object[]; fail?: string | null }) {
  const file = Bun.file(`${root}/github.json`);
  const current: object = (await file.exists()) ? z.looseObject({}).parse(await file.json()) : {};
  await Bun.write(file, JSON.stringify({ ...current, ...change }));
}

function pull(change: Record<string, unknown> = {}): Pull {
  return {
    number: 7,
    url: "https://github.com/example/one/pull/7",
    headRefName: "task/12-implement",
    headRepository: "example/one",
    state: "OPEN",
    ...change,
  };
}

async function entry(source: string, assignment = "implement") {
  const next = await run(["next", "--source", source]);
  const rows = z
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
    .data.sources.flatMap((row) => [...row.actions, ...row.waits]);
  return rows.find((row) => row.assignment === assignment);
}

const statusSchema = z.object({
  data: z.object({
    launches: z.array(
      z.looseObject({
        id: z.string(),
        attempt: z.number(),
        state: z.string(),
        paneId: z.string().nullable(),
        worktreePath: z.string().nullable(),
        internalReview: z.boolean().nullable(),
      }),
    ),
    internalReviews: z.array(
      z.looseObject({ handoffState: z.string(), handoffRunning: z.boolean() }),
    ),
  }),
});

async function shown(source: string) {
  return statusSchema.parse((await run(["source", "show", "--source", source])).output).data;
}

/** The association starts the handoff in its own process. Each test waits until it stops. */
async function handedOff(source: string) {
  let review = (await shown(source)).internalReviews[0];
  for (
    let attempt = 0;
    attempt < 200 && (review === undefined || review.handoffRunning);
    attempt++
  ) {
    await Bun.sleep(100);
    review = (await shown(source)).internalReviews[0];
  }
  return review;
}

async function calls(file: string, text: string) {
  const handle = Bun.file(`${root}/${file}`);
  if (!(await handle.exists())) return 0;
  return (await handle.text())
    .trim()
    .split("\n")
    .filter((line) => line.includes(text)).length;
}

async function commit(worktree: string, file: string) {
  await Bun.write(`${worktree}/${file}`, `${file}\n`);
  await git(worktree, "add", ".");
  await git(worktree, "commit", "-q", "-m", file);
  return git(worktree, "rev-parse", "HEAD");
}

async function findings(items: object[]) {
  const file = `${root}/findings.json`;
  await Bun.write(file, JSON.stringify({ findings: items }));
  return file;
}

test("associate refuses a ready PR and an unclean or unpushed worktree, and changes nothing", async () => {
  const source = await setup("opencode");
  const worker = await dispatch(source);
  expect((await shown(source)).launches[0]).toMatchObject({ internalReview: true });
  const head = await commit(worker.worktreePath, "work.txt");

  await github({ pulls: [pull({ head })] });
  expect(await run(["pr", "associate"], worker.worktreePath)).toMatchObject({
    code: 3,
    output: { reason: "pr_draft_required" },
  });
  await github({ pulls: [pull({ head, isDraft: true })] });
  await Bun.write(`${worker.worktreePath}/notes.txt`, "unlanded\n");
  expect(await run(["pr", "associate"], worker.worktreePath)).toMatchObject({
    code: 3,
    output: { reason: "pr_worktree_unclean" },
  });
  await rm(`${worker.worktreePath}/notes.txt`);
  await github({ pulls: [pull({ head: "older", isDraft: true })] });
  expect(await run(["pr", "associate"], worker.worktreePath)).toMatchObject({
    code: 3,
    output: {
      reason: "pr_worktree_unsynced",
      blockers: [
        {
          detail: expect.stringContaining(
            `The worktree is at ${head}, but the PR head is older.`,
          ) as unknown,
        },
      ],
    },
  });

  // Each refusal left the assignment running with no PR, review, or pane close.
  expect(await entry(source)).toMatchObject({ action: "wait", reason: "assignment_active" });
  expect((await shown(source)).internalReviews).toEqual([]);
  expect(await calls("herdr-calls.jsonl", '"pane","close"')).toBe(0);
}, 180000);

test("a handoff that cannot close the implementer's pane stays retryable, and the implementer stops", async () => {
  const source = await setup("opencode");
  const worker = await dispatch(source);
  const head = await commit(worker.worktreePath, "work.txt");
  await github({ pulls: [pull({ head, isDraft: true })] });
  await herdrFail({ "pane close": "the pane is busy" });
  expect(await run(["pr", "associate"], worker.worktreePath)).toMatchObject({ code: 0 });
  expect(await handedOff(source)).toMatchObject({ handoffState: "failed" });
  expect(await entry(source)).toMatchObject({
    action: "retry_handoff",
    reason: "internal_review_handoff_failed",
    internalReview: {
      handoff: { state: "failed", detail: expect.stringContaining("the pane is busy") as unknown },
    },
  });
  // The implementer handed its PR over, so its PR commands refuse.
  for (const command of [
    ["pr", "wait", "--timeout", "0"],
    ["pr", "merge"],
    ["pr", "round", "--file", await findings([])],
  ])
    expect(await run(command, worker.worktreePath)).toMatchObject({
      code: 4,
      output: { reason: "pr_handed_off" },
    });
  await herdrFail({});
  expect(await run(["handoff", "--source", source, "--assignment", "implement"])).toMatchObject({
    code: 0,
    output: {
      reason: "handoff_finished",
      data: { reviewer: { worktreePath: worker.worktreePath } },
    },
  });
  expect((await shown(source)).launches.map((row) => row.state)).toEqual(["finished", "running"]);
  expect(await entry(source)).toMatchObject({ action: "wait", reason: "pr_feedback_loop" });
}, 180000);

test("with internal review off, associate records a ready PR and the owner keeps it", async () => {
  const source = await setup("opencode");
  await Bun.write(
    `${root}/config/operator/config.json`,
    JSON.stringify({
      superAgent: { host: "opencode", model: "test/reasoner" },
      review: { internal: false },
    }),
  );
  const worker = await dispatch(source);
  expect((await shown(source)).launches[0]).toMatchObject({ internalReview: false });
  await Bun.write(`${worker.worktreePath}/notes.txt`, "unlanded\n");
  await github({ pulls: [pull()] });
  expect(await run(["pr", "associate"], worker.worktreePath)).toMatchObject({
    code: 0,
    output: { reason: "pr_associated", data: { internalReview: null } },
  });
  expect((await shown(source)).internalReviews).toEqual([]);
  expect(await calls("herdr-calls.jsonl", '"pane","close"')).toBe(0);
  expect(
    await run(["pr", "round", "--file", await findings([])], worker.worktreePath),
  ).toMatchObject({
    code: 3,
    output: { reason: "internal_review_not_recorded" },
  });
}, 180000);

async function herdrFail(fail: Record<string, string>) {
  const file = Bun.file(`${root}/herdr-state.json`);
  const state = z.looseObject({}).parse(await file.json());
  await Bun.write(file, JSON.stringify({ ...state, fail }));
}
