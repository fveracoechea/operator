import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
// Bun has no temporary-directory, symlink, permission, or recursive removal API.
import {
  writeClaudeHookSettings,
  writeOpenCodePlugin,
  writeGuideSkills,
} from "./command-fixture.ts";
import { chmod, cp, mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { z } from "zod";
import { Environment } from "../environment/main.ts";
import { workflowOutputSchema } from "../../lib/cli-result-fixture.ts";
import { expectWorkflowRefusal } from "./worker-fixture.ts";
import { fakeHerdrScript } from "./herdr-fixture.ts";
import { fakeGithubScript } from "./github-fixture.ts";

// Internal review is on by default, so these tests set no review setting. ADR-0020.

let root = "";
let checkout = "";
const workerPanes = new Map<string, string>();
const cli = Bun.fileURLToPath(new URL("../../cli.ts", import.meta.url));
const gitEnv = {
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "Fixture",
  GIT_AUTHOR_EMAIL: "fixture@example.com",
  GIT_COMMITTER_NAME: "Fixture",
  GIT_COMMITTER_EMAIL: "fixture@example.com",
};

function environment(cwd = checkout) {
  return Environment.child({
    ...gitEnv,
    HOME: `${root}/home`,
    XDG_CONFIG_HOME: `${root}/config`,
    XDG_STATE_HOME: `${root}/state`,
    BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0",
    HERDR_SOCKET_PATH: `${root}/herdr.sock`,
    PATH: `${root}/tools:${Environment.read().PATH}`,
    OPENCODE_SESSION_ID: "ses_synthetic_supervisor",
    CLAUDE_CODE_SESSION_ID: undefined,
    HERDR_PANE_ID: workerPanes.get(cwd) ?? "synthetic-supervisor-pane",
  });
}

async function exec(args: string[], cwd = checkout) {
  const child = Bun.spawn(args, { cwd, env: environment(cwd), stdout: "pipe", stderr: "pipe" });
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { code, stdout, stderr };
}

async function run(args: string[], cwd = checkout) {
  const result = await exec([process.execPath, cli, ...args, "--json"], cwd);
  const output = workflowOutputSchema.parse(JSON.parse(result.stdout));
  expectWorkflowRefusal(args, output, result.stderr);
  return { code: result.code, output, stderr: result.stderr };
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
const opencode = `#!${process.execPath}
if(process.argv[3]==="post") console.log(JSON.stringify({data:{id:"ses_worker",...JSON.parse(process.argv[6])}}));
else {const dir=decodeURIComponent(process.argv[4].split("=")[1]);console.log(JSON.stringify({location:{directory:dir},data:[{providerID:"test",id:"reasoner",enabled:true,variants:[{id:"medium"},{id:"high"}]}]}));}
`;

const plan = {
  trackerKey: "github:example/one#10",
  assignments: [
    {
      key: "implement",
      trackerKey: "github:example/one#12",
      instructions: "Implement the change.",
      kind: "implementation",
      resources: "worktree",
      branch: "task/12-implement",
      dependencies: [],
    },
    {
      key: "second",
      trackerKey: "github:example/one#13",
      instructions: "Implement the second change.",
      kind: "implementation",
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
  await cp(Bun.fileURLToPath(new URL("../../../skills", import.meta.url)), `${root}/release`, {
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
  await writeGuideSkills(upstream);
  await writeClaudeHookSettings(`${root}/home`);
  await writeOpenCodePlugin(`${root}/config`);
  expect((await run(["project", "register"])).code).toBe(0);
  expect((await run(["herdr", "install"])).code).toBe(0);
  await Bun.write(`${root}/plan.json`, JSON.stringify(plan));
  const registered = await run(["source", "register", "--file", `${root}/plan.json`]);
  return z.object({ data: z.object({ id: z.string() }) }).parse(registered.output).data.id;
}

afterEach(async () => {
  workerPanes.clear();
  await rm(root, { recursive: true, force: true });
});

async function dispatch(source: string, assignment = "implement") {
  const launched = await run(["dispatch", "--source", source, "--assignment", assignment]);
  expect(launched.code, launched.stderr).toBe(0);
  const worker = z
    .object({ data: z.object({ worktreePath: z.string(), paneId: z.string(), brief: z.string() }) })
    .parse(launched.output).data;
  workerPanes.set(worker.worktreePath, worker.paneId);
  return worker;
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
    pullRequests: z.array(z.looseObject({})),
  }),
});

async function shown(source: string) {
  return statusSchema.parse((await run(["source", "show", "--source", source])).output).data;
}

/**
 * The association starts the handoff in its own process. The reviewer's reservation ends the
 * handoff before the reviewer runs, so each test waits until no launch is starting either.
 */
async function handedOff(source: string) {
  function settled(state: Awaited<ReturnType<typeof shown>>) {
    const review = state.internalReviews[0];
    return (
      review !== undefined &&
      !review.handoffRunning &&
      state.launches.every((launch) => launch.state !== "starting")
    );
  }
  let state = await shown(source);
  for (let attempt = 0; attempt < 300 && !settled(state); attempt++) {
    await Bun.sleep(100);
    state = await shown(source);
  }
  return state.internalReviews[0];
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

async function findings(
  items: { severity: string; axis: string; location: string; claim: string }[],
) {
  const file = `${root}/findings.md`;
  await Bun.write(
    file,
    `## Findings\n${items.map((item) => `- ${item.severity}, ${item.axis}, ${item.location}: ${item.claim}`).join("\n")}\n`,
  );
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
    output: {
      reason: "pr_worktree_unclean",
      kind: "implementation",
      phase: "build",
      next: { command: "git status --short" },
      state: { worktree_clean: false },
    },
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

test("a running handoff shows wait with kind_handoff and launches no second worker", async () => {
  const source = await setup("opencode");
  const worker = await dispatch(source);
  const head = await commit(worker.worktreePath, "work.txt");
  await github({ pulls: [pull({ head, isDraft: true })] });
  const file = Bun.file(`${root}/herdr-state.json`);
  const state = z.looseObject({}).parse(await file.json());
  await Bun.write(file, JSON.stringify({ ...state, pausePaneClose: true }));
  expect(await run(["pr", "associate"], worker.worktreePath)).toMatchObject({ code: 0 });
  try {
    for (
      let attempt = 0;
      attempt < 100 && !(await Bun.file(`${root}/pane-close-entered`).exists());
      attempt++
    )
      await Bun.sleep(10);
    expect(await Bun.file(`${root}/pane-close-entered`).exists()).toBe(true);
    expect(await entry(source)).toMatchObject({
      action: "wait",
      reason: "kind_handoff",
      handoff: { nextKind: "review", state: "pending" },
    });
    expect(await run(["dispatch", "--source", source, "--assignment", "implement"])).toMatchObject({
      code: 4,
      output: { reason: "handoff_running" },
    });
    expect((await shown(source)).launches).toHaveLength(1);
  } finally {
    await Bun.write(`${root}/pane-close-allowed`, "continue");
    expect(await handedOff(source)).toMatchObject({ handoffState: "done" });
  }
}, 180000);

test("a failed handoff shows as replace_worker with handoff_failed and starts the next kind", async () => {
  const source = await setup("opencode");
  const worker = await dispatch(source);
  const head = await commit(worker.worktreePath, "work.txt");
  await github({ pulls: [pull({ head, isDraft: true })] });
  await herdrFail({ "pane close": "the pane is busy" });
  expect(await run(["pr", "associate"], worker.worktreePath)).toMatchObject({ code: 0 });
  expect(await handedOff(source)).toMatchObject({ handoffState: "failed" });
  expect(await entry(source)).toMatchObject({
    action: "replace_worker",
    reason: "handoff_failed",
    internalReview: {
      handoff: { state: "failed", detail: expect.stringContaining("the pane is busy") as unknown },
    },
  });
  // The implementer handed its PR over, so each of its PR commands refuses the same way.
  for (const command of [
    ["pr", "wait", "--timeout", "0"],
    ["pr", "merge"],
    ["pr", "round", "--file", await findings([])],
  ])
    expect(await run(command, worker.worktreePath)).toMatchObject({
      code: 4,
      output: {
        reason: "pr_handed_off",
        kind: "implementation",
        phase: "handoff",
        next: { why: "This launch handed the PR to its reviewer. Stop here." },
        blockers: [
          {
            detail: "This launch no longer owns the PR.",
          },
        ],
        state: { handedOff: true },
      },
    });
  // A retry that meets the same Herdr failure exits as a dispatch does.
  expect(await run(["dispatch", "--source", source, "--assignment", "implement"])).toMatchObject({
    code: 1,
    output: { reason: "herdr_failed" },
  });
  await herdrFail({});
  expect(await run(["dispatch", "--source", source, "--assignment", "implement"])).toMatchObject({
    code: 0,
    output: {
      reason: "worker_launched",
      data: { kind: { name: "review", readsNote: false }, worktreePath: worker.worktreePath },
    },
  });
  expect((await shown(source)).launches.map((row) => row.state)).toEqual(["finished", "running"]);
  expect(await entry(source)).toMatchObject({ action: "wait", reason: "assignment_active" });
}, 180000);

test("stopped handoff recovery serializes competing dispatches and preserves the recorded next kind", async () => {
  const source = await setup("opencode");
  const worker = await dispatch(source);
  const head = await commit(worker.worktreePath, "work.txt");
  await github({ pulls: [pull({ head, isDraft: true })] });
  await herdrFail({ "pane close": "the pane is busy" });
  expect((await run(["pr", "associate"], worker.worktreePath)).code).toBe(0);
  expect(await handedOff(source)).toMatchObject({ handoffState: "failed" });
  await herdrFail({});
  // The recovery process holds the handoff while waiting for this synthetic parent, before any close effect.
  using db = new Database(`${root}/state/operator/operator.sqlite`);
  db.query("UPDATE kind_handoffs SET handoff_state = 'pending', owner_pid = ?, lease_at = ?").run(
    process.pid,
    new Date().toISOString(),
  );
  const child = Bun.spawn(
    [
      process.execPath,
      cli,
      "dispatch",
      "--source",
      source,
      "--assignment",
      "implement",
      "--after-pid",
      String(process.pid),
      "--json",
    ],
    { cwd: checkout, env: environment(worker.worktreePath), stdout: "pipe", stderr: "pipe" },
  );
  db.query("UPDATE kind_handoffs SET owner_pid = ?").run(child.pid);
  try {
    let state = await shown(source);
    for (let attempt = 0; attempt < 100 && !state.internalReviews[0]?.handoffRunning; attempt++) {
      await Bun.sleep(10);
      state = await shown(source);
    }
    expect(await entry(source)).toMatchObject({ action: "wait", reason: "kind_handoff" });
    expect(state.launches).toHaveLength(1);
  } finally {
    child.kill("SIGTERM");
    await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
  }
  expect(await entry(source)).toMatchObject({
    action: "replace_worker",
    reason: "handoff_failed",
    handoff: { nextKind: "review", state: "stopped" },
    next: { command: `operator dispatch --source ${source} --assignment implement` },
  });

  const stateFile = Bun.file(`${root}/herdr-state.json`);
  await Bun.write(
    stateFile,
    JSON.stringify({ ...z.looseObject({}).parse(await stateFile.json()), pausePaneClose: true }),
  );
  const recovering = exec([
    process.execPath,
    cli,
    "dispatch",
    "--source",
    source,
    "--assignment",
    "implement",
    "--json",
  ]);
  try {
    for (
      let attempt = 0;
      attempt < 100 && !(await Bun.file(`${root}/pane-close-entered`).exists());
      attempt++
    )
      await Bun.sleep(10);
    expect(await Bun.file(`${root}/pane-close-entered`).exists()).toBe(true);
    expect(await run(["dispatch", "--source", source, "--assignment", "implement"])).toMatchObject({
      code: 4,
      output: { reason: "handoff_running" },
    });
    expect((await shown(source)).launches).toHaveLength(1);
  } finally {
    await Bun.write(`${root}/pane-close-allowed`, "continue");
    const result = await recovering;
    expect(result.code, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      reason: "worker_launched",
      data: {
        assignment: "implement",
        kind: { name: "review" },
        worktreePath: worker.worktreePath,
        branch: "task/12-implement",
      },
    });
  }
  expect((await shown(source)).launches.map((row) => row.state)).toEqual(["finished", "running"]);
  expect(await handedOff(source)).toMatchObject({ handoffState: "done" });
  expect(await calls("herdr-calls.jsonl", '"worktree","open"')).toBe(1);
}, 180000);

test("the removed handoff command is refused without closing a pane or starting a worker", async () => {
  const source = await setup("opencode");
  await dispatch(source);
  expect(await run(["handoff", "--source", source, "--assignment", "implement"])).toMatchObject({
    code: 2,
    output: { reason: "invalid_arguments", next: { command: "operator --help" } },
  });
  expect((await shown(source)).launches).toHaveLength(1);
  expect(await calls("herdr-calls.jsonl", '"pane","close"')).toBe(0);
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
  const head = await commit(worker.worktreePath, "notes.txt");
  await github({ pulls: [pull({ head })] });
  await Bun.write(`${worker.worktreePath}/unlanded.txt`, "retain this work\n");
  expect(await git(worker.worktreePath, "status", "--porcelain")).toBe("?? unlanded.txt");
  const closes = await calls("herdr-calls.jsonl", '"pane","close"');
  const starts = await calls("herdr-calls.jsonl", '"agent","start"');
  expect(await run(["pr", "associate"], worker.worktreePath)).toMatchObject({
    code: 3,
    output: {
      reason: "pr_worktree_unclean",
      kind: "implementation",
      phase: "build",
      next: { command: "git status --short" },
      state: { worktree_clean: false },
    },
  });
  expect((await shown(source)).pullRequests).toEqual([]);
  expect(await Bun.file(`${worker.worktreePath}/unlanded.txt`).text()).toBe("retain this work\n");
  expect(await calls("herdr-calls.jsonl", '"pane","close"')).toBe(closes);
  expect(await calls("herdr-calls.jsonl", '"agent","start"')).toBe(starts);
  await rm(`${worker.worktreePath}/unlanded.txt`);
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
