import { afterEach, expect, test } from "bun:test";
// Bun has no temporary-directory, symlink, permission, or recursive removal API.
import { writeClaudeHookSettings, writeOpenCodePlugin } from "./command-fixture.ts";
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
  await writeOpenCodePlugin(`${root}/config`);
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

async function findings(items: object[]) {
  const file = `${root}/findings.json`;
  await Bun.write(file, JSON.stringify({ findings: items }));
  return file;
}

const blocker = {
  axis: "Spec",
  severity: "blocker",
  location: "a.ts:1",
  claim: "The guard is missing.",
};

test("associate hands a clean draft to a fresh reviewer launch in the same worktree", async () => {
  const source = await setup("opencode");
  const worker = await dispatch(source);
  const head = await commit(worker.worktreePath, "work.txt");
  await github({ pulls: [pull({ head, isDraft: true })] });

  expect(await run(["pr", "associate"], worker.worktreePath)).toMatchObject({
    code: 0,
    output: {
      reason: "pr_associated",
      data: {
        number: 7,
        state: "pr-open",
        internalReview: { state: "reviewing", handoff: "started" },
      },
    },
  });
  expect(await handedOff(source)).toMatchObject({ handoffState: "done" });

  const { launches } = await shown(source);
  expect(launches).toMatchObject([
    { attempt: 1, state: "finished", paneId: worker.paneId },
    { attempt: 2, state: "running", worktreePath: worker.worktreePath, internalReview: true },
  ]);
  expect(await calls("herdr-calls.jsonl", `"pane","close","${worker.paneId}"`)).toBe(1);
  expect(await calls("herdr-calls.jsonl", '"worktree","open"')).toBe(1);
  // The reviewer brief comes from the recorded review, with no draft-state wording.
  const brief = await Bun.file(worker.brief).text();
  expect(brief).toContain("You are the internal reviewer of PR #7.");
  expect(brief).toContain("No round is recorded yet.");
  expect(brief).not.toContain("If the PR is a draft");
  // The review runs as a wait, and the handoff left no failure in next.
  expect(await entry(source)).toMatchObject({
    action: "wait",
    reason: "internal_review_running",
    internalReview: { state: "reviewing", rounds: [], handoff: { state: "done" } },
  });
  // A repeated association or handoff starts nothing.
  expect(await run(["pr", "associate"], worker.worktreePath)).toMatchObject({
    output: { reason: "pr_unchanged" },
  });
  expect(await run(["handoff", "--source", source, "--assignment", "implement"])).toMatchObject({
    code: 0,
    output: { reason: "handoff_unchanged" },
  });
  expect((await shown(source)).launches).toHaveLength(2);
}, 180000);

test("a failed reviewer start shows as replace_worker, and a dispatch starts the reviewer", async () => {
  const source = await setup("opencode");
  const worker = await dispatch(source);
  const head = await commit(worker.worktreePath, "work.txt");
  await github({ pulls: [pull({ head, isDraft: true })] });
  await herdrFail({ "agent start": "the host did not start" });

  expect(await run(["pr", "associate"], worker.worktreePath)).toMatchObject({ code: 0 });
  expect(await handedOff(source)).toMatchObject({ handoffState: "done" });
  expect(await entry(source)).toMatchObject({ action: "replace_worker", reason: "launch_failed" });

  await herdrFail({});
  expect((await run(["dispatch", "--source", source, "--assignment", "implement"])).code).toBe(0);
  expect((await shown(source)).launches.map((row) => row.state)).toEqual([
    "finished",
    "failed",
    "running",
  ]);
  expect(await Bun.file(worker.brief).text()).toContain("You are the internal reviewer of PR #7.");
}, 180000);

test("the reviewer records at most two rounds, the second at a newer head", async () => {
  const source = await setup("opencode");
  const worker = await dispatch(source);
  const first = await commit(worker.worktreePath, "work.txt");
  await github({ pulls: [pull({ head: first, isDraft: true })] });
  expect((await run(["pr", "associate"], worker.worktreePath)).code).toBe(0);
  await handedOff(source);
  const reviewer = worker.worktreePath;

  await Bun.write(`${root}/broken.json`, "{");
  expect(await run(["pr", "round", "--file", `${root}/broken.json`], reviewer)).toMatchObject({
    code: 3,
    output: { reason: "internal_review_findings_invalid" },
  });
  expect(
    await run(
      ["pr", "round", "--file", await findings([{ ...blocker, axis: "Security" }])],
      reviewer,
    ),
  ).toMatchObject({ code: 3, output: { reason: "internal_review_findings_invalid" } });
  expect(
    await run(["pr", "round", "--file", await findings([{ ...blocker, note: "extra" }])], reviewer),
  ).toMatchObject({ code: 3, output: { reason: "internal_review_findings_invalid" } });

  const nit = { axis: "Skills", severity: "nice-to-have", location: "b.ts", claim: "Name it." };
  expect(
    await run(["pr", "round", "--file", await findings([blocker, nit])], reviewer),
  ).toMatchObject({
    code: 0,
    output: {
      reason: "pr_round_recorded",
      data: { round: 1, head: first, findings: 2, blockers: 1 },
    },
  });
  expect(await run(["pr", "round", "--file", await findings([])], reviewer)).toMatchObject({
    code: 3,
    output: { reason: "internal_review_round_head" },
  });

  const second = await commit(reviewer, "fix.txt");
  expect(await run(["pr", "round", "--file", await findings([])], reviewer)).toMatchObject({
    code: 0,
    output: { data: { round: 2, head: second, findings: 0, blockers: 0 } },
  });
  await commit(reviewer, "more.txt");
  expect(await run(["pr", "round", "--file", await findings([])], reviewer)).toMatchObject({
    code: 3,
    output: { reason: "internal_review_round_limit" },
  });
  expect(await entry(source)).toMatchObject({
    internalReview: {
      rounds: [
        { number: 1, head: first, findings: 2, blockers: 1 },
        { number: 2, head: second, findings: 0, blockers: 0 },
      ],
    },
  });

  // A replacement reviewer reads the recorded rounds in its brief.
  await exec(["herdr", "pane", "exit", (await shown(source)).launches[1]?.paneId ?? "", "w"]);
  expect(await entry(source)).toMatchObject({
    action: "replace_worker",
    reason: "worker_interrupted",
  });
  expect((await run(["dispatch", "--source", source, "--assignment", "implement"])).code).toBe(0);
  const brief = await Bun.file(worker.brief).text();
  expect(brief).toContain(
    `- Round 1 at \`${first}\`:\n  - Spec, blocker, \`a.ts:1\`: The guard is missing.`,
  );
  expect(brief).toContain(`- Round 2 at \`${second}\`: no findings.`);
}, 180000);

async function herdrFail(fail: Record<string, string>) {
  const file = Bun.file(`${root}/herdr-state.json`);
  const state = z.looseObject({}).parse(await file.json());
  await Bun.write(file, JSON.stringify({ ...state, fail }));
}
