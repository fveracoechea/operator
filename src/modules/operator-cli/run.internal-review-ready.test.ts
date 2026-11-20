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

async function exec(args: string[], cwd = checkout, stdin?: string) {
  const child = Bun.spawn(args, {
    cwd,
    env: environment(cwd),
    stdout: "pipe",
    stderr: "pipe",
    stdin: stdin === undefined ? "ignore" : new Blob([stdin]),
  });
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { code, stdout, stderr };
}

async function run(args: string[], cwd = checkout, stdin?: string, pane?: string) {
  const result = await exec(
    [
      ...(pane === undefined ? [] : ["env", `HERDR_PANE_ID=${pane}`]),
      process.execPath,
      cli,
      ...args,
      "--json",
    ],
    cwd,
    stdin,
  );
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

type FixturePlan = Omit<typeof plan, "assignments"> & {
  assignments: (Omit<(typeof plan.assignments)[number], "dependencies"> & {
    dependencies: string[];
  })[];
};

async function setup(
  host: "opencode" | "claude-code",
  suppliedPlan: FixturePlan = plan,
  kind?: "custom" | "legacy",
) {
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
  const settings = {
    superAgent:
      host === "opencode" ? { host, model: "test/reasoner" } : { host, model: "precise-model" },
  };
  if (kind !== undefined) Object.assign(settings, { review: { internal: false } });
  if (kind === "custom")
    Object.assign(settings, {
      kinds: {
        custom: {
          completion: "pr",
          resources: "worktree",
          guide: "worker-agent/SKILL.md",
          nextKind: null,
          readsNote: false,
          workPhases: [{ name: "implement", goal: "Implement." }],
        },
      },
    });
  await Bun.write(`${root}/config/operator/config.json`, JSON.stringify(settings), {
    createPath: true,
  });
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
  await Bun.write(
    `${root}/plan.json`,
    JSON.stringify(
      kind === undefined || kind === "legacy"
        ? suppliedPlan
        : {
            ...suppliedPlan,
            assignments: suppliedPlan.assignments.map(({ kind: _kind, ...assignment }) => ({
              ...assignment,
              kind: "custom",
            })),
          },
    ),
  );
  const registered = await run(["source", "register", "--file", `${root}/plan.json`]);
  expect(registered.code, registered.stderr).toBe(0);
  const id = z.object({ data: z.object({ id: z.string() }) }).parse(registered.output).data.id;
  if (kind === "legacy") {
    using db = new Database(`${root}/state/operator/operator.sqlite`);
    const assignments = suppliedPlan.assignments.map(({ kind: _kind, ...assignment }) => ({
      ...assignment,
      completion: "pr",
    }));
    db.query("UPDATE sources SET plan = ? WHERE id = ?").run(
      JSON.stringify({ ...suppliedPlan, assignments }),
      id,
    );
    db.query("UPDATE assignments SET kind = NULL WHERE source_id = ?").run(id);
  }
  return id;
}

afterEach(async () => {
  workerPanes.clear();
  await rm(root, { recursive: true, force: true });
});

async function dispatch(source: string, assignment = "implement", kind?: string) {
  const launched = await run([
    "dispatch",
    "--source",
    source,
    "--assignment",
    assignment,
    ...(kind === undefined ? [] : ["--kind", kind]),
  ]);
  expect(launched.code, launched.stderr).toBe(0);
  const worker = z
    .object({ data: z.object({ worktreePath: z.string(), paneId: z.string(), brief: z.string() }) })
    .parse(launched.output).data;
  workerPanes.set(worker.worktreePath, worker.paneId);
  return worker;
}

type Pull = Record<string, unknown> & { number: number };
async function github(change: {
  pulls?: Pull[];
  commentLost?: boolean;
  readyLost?: boolean;
  mergeRefuse?: boolean;
  graphqlErrors?: boolean;
  repeatTerminal?: "comments" | "threadComments" | null;
}) {
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
    assignments: z.array(z.object({ key: z.string(), state: z.string() })),
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
    internalReviewRounds: z.array(z.looseObject({ number: z.number() })),
    pullRequests: z.array(z.looseObject({ parking: z.unknown().optional() })),
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

const blocker = {
  axis: "Spec",
  severity: "blocker",
  location: "a.ts:1",
  claim: "The guard is missing.",
};

const nit = { axis: "Skills", severity: "nice-to-have", location: "b.ts", claim: "Name it." };

async function summary(
  overview: string,
  dispositions: { round: number; finding: number; disposition: string; reason?: string }[],
) {
  const file = `${root}/summary.md`;
  await Bun.write(
    file,
    `## Overview\n${overview}\n\n## Dispositions\n${dispositions.map((item) => `- ${item.round}.${item.finding} ${item.disposition}${item.disposition === "declined" ? `: ${item.reason ?? ""}` : ""}`).join("\n")}\n`,
  );
  return file;
}

async function config(review: { assignments?: boolean; internal?: boolean }) {
  await Bun.write(
    `${root}/config/operator/config.json`,
    JSON.stringify({ superAgent: { host: "opencode", model: "test/reasoner" }, review }),
  );
}

const githubSchema = z.looseObject({
  commented: z.array(z.object({ id: z.string(), number: z.number(), body: z.string() })).optional(),
  readied: z.array(z.number()).optional(),
  updated: z.array(z.object({ id: z.string(), body: z.string() })).optional(),
  pulls: z.array(z.looseObject({ comments: z.array(z.looseObject({})).optional() })),
});

async function githubState() {
  return githubSchema.parse(await Bun.file(`${root}/github.json`).json());
}

async function reviewRequests() {
  const read = await run(["review", "next"]);
  return z.object({ data: z.object({ requests: z.array(z.looseObject({})) }) }).parse(read.output)
    .data.requests;
}

/** The implementer associates a clean draft, and the handoff starts the reviewer. */
async function reviewing(source: string) {
  const worker = await dispatch(source);
  const head = await commit(worker.worktreePath, "work.txt");
  await github({ pulls: [pull({ head, isDraft: true })] });
  expect((await run(["pr", "associate"], worker.worktreePath)).code).toBe(0);
  expect(await handedOff(source)).toMatchObject({ handoffState: "done" });
  workerPanes.set(worker.worktreePath, (await shown(source)).launches.at(-1)?.paneId ?? "");
  return { reviewer: worker.worktreePath, brief: worker.brief, head };
}

/** The reviewer's push, which the fake GitHub reports as the PR head. */
async function push(reviewer: string, file: string, change: Record<string, unknown> = {}) {
  const head = await commit(reviewer, file);
  await github({ pulls: [pull({ head, isDraft: true, ...change })] });
  return head;
}

async function feedbackLaunch(source: string, attempt = 3) {
  let state = await shown(source);
  for (
    let tries = 0;
    tries < 300 &&
    !(state.launches.length >= attempt && state.launches.at(-1)?.state === "running");
    tries++
  ) {
    await Bun.sleep(100);
    state = await shown(source);
  }
  expect(state.launches.at(-1)).toMatchObject({
    attempt,
    state: "running",
    kind: { name: "pr-feedback" },
  });
  const latest = state.launches.at(-1);
  expect(latest?.paneId).not.toBeNull();
  workerPanes.set(latest?.worktreePath ?? "", latest?.paneId ?? "");
  return state;
}

async function feedbackFixture() {
  const source = await setup("opencode");
  await config({ internal: false });
  const worker = await dispatch(source);
  const head = await commit(worker.worktreePath, "work.txt");
  await github({
    pulls: [pull({ head, isDraft: false, checks: [{ name: "ci", conclusion: "SUCCESS" }] })],
  });
  expect((await run(["pr", "associate"], worker.worktreePath)).code).toBe(0);
  await feedbackLaunch(source, 2);
  return { source, worker, head };
}

test("a pr wait with no event parks the assignment and ends the launch while retaining only its park note", async () => {
  const { source, worker, head } = await feedbackFixture();
  const waited = await run(
    ["pr", "wait", "--timeout", "0", "--note", "-"],
    worker.worktreePath,
    "Check the unanswered question. `literal` $HOME\n",
  );
  expect(waited).toMatchObject({ code: 0, output: { reason: "pr_parked" } });
  let state = await shown(source);
  for (let tries = 0; tries < 100 && state.launches.at(-1)?.state !== "finished"; tries++) {
    await Bun.sleep(50);
    state = await shown(source);
  }
  expect(state.launches).toHaveLength(2);
  expect(state.launches.at(-1)).toMatchObject({
    state: "finished",
    worktreePath: worker.worktreePath,
  });
  const parking = z
    .object({
      state: z.literal("parked"),
      head: z.string(),
      note: z.string(),
      events: z.array(z.string()),
    })
    .parse(state.pullRequests[0]?.parking);
  expect(parking.head).toBe(head);
  expect(parking.events).toEqual([]);
  expect(await Bun.file(parking.note).text()).toBe(
    "Check the unanswered question. `literal` $HOME\n",
  );
  expect(await git(worker.worktreePath, "rev-parse", "HEAD")).toBe(head);
  expect(await entry(source)).toMatchObject({ action: "wait", reason: "pr_parked" });
  expect(await run(["dispatch", "--source", source, "--assignment", "implement"])).toMatchObject({
    code: 4,
    output: { reason: "assignment_not_dispatchable" },
  });
  expect((await shown(source)).launches).toEqual(state.launches);
  expect(await calls("herdr-calls.jsonl", '"agent","start"')).toBe(2);
  expect(await calls("gh-calls.jsonl", "mutation")).toBe(0);
}, 120000);

test("checks running on the pushed head continue the wait and retain no supplied park note", async () => {
  const { source, worker, head } = await feedbackFixture();
  await github({ pulls: [pull({ head, checks: [{ name: "ci" }] })] });
  const before = await shown(source);
  expect(
    await run(
      ["pr", "wait", "--timeout", "0", "--note", "-"],
      worker.worktreePath,
      "Do not retain this note.\n",
    ),
  ).toMatchObject({
    code: 0,
    output: { reason: "pr_checks_running", next: { command: "operator pr wait" } },
  });
  expect((await shown(source)).launches).toEqual(before.launches);
  expect((await shown(source)).pullRequests[0]?.parking).toBeNull();
  expect(await Array.fromAsync(new Bun.Glob("**/park-*.md").scan(`${root}/state`))).toEqual([]);
  expect(await calls("herdr-calls.jsonl", '"pane","close"')).toBe(1);
}, 120000);

test("an event-returning wait retains no park note and checks on a different head do not hold the worker", async () => {
  const { source, worker, head } = await feedbackFixture();
  const before = await shown(source);
  expect(
    await run(
      ["pr", "wait", "--timeout", "0", "--note", "-"],
      worker.worktreePath,
      Array.from({ length: 61 }, () => "Too long.").join("\n"),
    ),
  ).toMatchObject({ output: { reason: "pr_note_invalid" } });
  expect(await shown(source)).toEqual(before);
  await github({
    pulls: [pull({ head, comments: [{ id: "C1", body: "Check this claim.", author: "person" }] })],
  });
  expect(
    await run(
      ["pr", "wait", "--timeout", "0", "--note", "-"],
      worker.worktreePath,
      "Not a retained note.\n",
    ),
  ).toMatchObject({ code: 0, output: { reason: "pr_events_observed" } });
  expect((await shown(source)).pullRequests[0]?.parking).toBeNull();
  expect(await Array.fromAsync(new Bun.Glob("**/park-*.md").scan(`${root}/state`))).toEqual([]);
  await github({ pulls: [pull({ head: "another-pushed-head", checks: [{ name: "ci" }] })] });
  expect(await run(["pr", "wait", "--timeout", "0"], worker.worktreePath)).toMatchObject({
    code: 0,
    output: { reason: "pr_parked" },
  });
  await latestWorker(source, worker.worktreePath, "finished");
}, 120000);

async function parkedFixture() {
  const fixture = await feedbackFixture();
  expect((await run(["pr", "wait", "--timeout", "0"], fixture.worker.worktreePath)).code).toBe(0);
  let state = await shown(fixture.source);
  for (let tries = 0; tries < 100 && state.launches.at(-1)?.state !== "finished"; tries++) {
    await Bun.sleep(50);
    state = await shown(fixture.source);
  }
  expect(state.launches.at(-1)?.state).toBe("finished");
  return fixture;
}

/** Time is an external boundary; each command still runs the real public CLI and SQLite. */
async function coordination(source: string, now: number, expectedCode = 0) {
  await Bun.write(`${root}/clock.ts`, `Date.now = () => ${now};\n`);
  const result = await exec([
    process.execPath,
    "--preload",
    `${root}/clock.ts`,
    cli,
    "next",
    "--source",
    source,
    "--wait",
    "--timeout",
    "0",
    "--json",
  ]);
  expect(result.code, result.stderr).toBe(expectedCode);
  return workflowOutputSchema.parse(JSON.parse(result.stdout));
}

test("new guarded merge eligibility wakes a parked PR without bypassing approval or merging", async () => {
  const { source, head } = await parkedFixture();
  const now = Date.now();
  await coordination(source, now);
  await github({
    pulls: [
      pull({ head, reviewDecision: "APPROVED", checks: [{ name: "ci", conclusion: "SUCCESS" }] }),
    ],
  });
  expect(await coordination(source, now + 900000)).toMatchObject({
    reason: "next_actions_changed",
    data: { sources: [{ actions: [{ action: "resume_pr_feedback", reason: "pr_feedback" }] }] },
  });
  expect(await coordination(source, now + 1800000)).toMatchObject({
    reason: "next_wait_timed_out",
    data: { sources: [] },
  });
  expect(await calls("gh-calls.jsonl", '"PUT"')).toBe(0);
}, 120000);

test("more than a hundred checks with a pending tail cannot park the pushed worker", async () => {
  const { source, worker, head } = await feedbackFixture();
  await github({
    pulls: [
      pull({
        head,
        checks: [
          ...Array.from({ length: 100 }, (_, index) => ({
            name: `ci-${index}`,
            conclusion: "SUCCESS",
          })),
          { name: "pending-tail" },
        ],
      }),
    ],
  });
  expect(await run(["pr", "wait", "--timeout", "0"], worker.worktreePath)).toMatchObject({
    output: { reason: "pr_checks_unknown", next: { command: "operator pr wait" } },
  });
  expect((await shown(source)).pullRequests[0]?.parking).toBeNull();
  expect((await shown(source)).launches.at(-1)?.state).toBe("running");
}, 120000);

test("parked feedback includes new and edited older-page comments without repeated quiet wakes", async () => {
  const { source, head } = await parkedFixture();
  const comments = Array.from({ length: 101 }, (_, index) => ({
    id: `C${index}`,
    body: `claim ${index}`,
    author: "person",
  }));
  const now = Date.now();
  await github({ pulls: [pull({ head, comments })] });
  expect(await coordination(source, now)).toMatchObject({ reason: "next_actions_changed" });
  const first = z
    .object({ events: z.array(z.string()) })
    .parse((await shown(source)).pullRequests[0]?.parking);
  expect(first.events.join("\n")).toContain("claim 100");
  expect(await coordination(source, now + 900000)).toMatchObject({ reason: "next_wait_timed_out" });
  comments[100] = { id: "C100", body: "edited older claim", author: "person" };
  await github({ pulls: [pull({ head, comments })] });
  await coordination(source, now + 1800000);
  const edited = z
    .object({ events: z.array(z.string()) })
    .parse((await shown(source)).pullRequests[0]?.parking);
  expect(edited.events).toHaveLength(first.events.length + 1);
  expect(edited.events.at(-1)).toContain("edited older claim");
  expect(await coordination(source, now + 2700000)).toMatchObject({
    reason: "next_wait_timed_out",
  });
}, 120000);

test("a parked GraphQL error preserves the receipt and schedule until a complete retry", async () => {
  const { source, head } = await parkedFixture();
  const now = Date.now();
  await coordination(source, now);
  using db = new Database(`${root}/state/operator/operator.sqlite`, { readonly: true });
  const receipt = db.query("SELECT progress, parking FROM pull_requests").all();
  const schedule = db.query("SELECT * FROM parked_pr_reads").all();
  await github({
    graphqlErrors: true,
    pulls: [pull({ head, comments: [{ id: "unread", body: "Check this claim." }] })],
  });
  expect(await coordination(source, now + 900000, 3)).toMatchObject({
    reason: "github_invalid_response",
  });
  expect(db.query("SELECT progress, parking FROM pull_requests").all()).toEqual(receipt);
  expect(db.query("SELECT * FROM parked_pr_reads").all()).toEqual(schedule);
  expect(await calls("herdr-calls.jsonl", '"agent","start"')).toBe(2);
  await github({ graphqlErrors: false });
  await coordination(source, now + 900001);
  expect(await entry(source)).toMatchObject({
    action: "resume_pr_feedback",
    reason: "pr_feedback",
  });
  const parking = (await shown(source)).pullRequests[0]?.parking;
  await coordination(source, now + 1800001);
  expect((await shown(source)).pullRequests[0]?.parking).toEqual(parking);
}, 120000);

test.each(["null", "incomplete"] as const)(
  "a live %s check observation refuses before feedback or eligibility acknowledgment",
  async (kind) => {
    const { source, worker, head } = await feedbackFixture();
    using db = new Database(`${root}/state/operator/operator.sqlite`, { readonly: true });
    const before = db.query("SELECT progress FROM pull_requests").all();
    await github({
      pulls: [
        pull({
          head,
          reviewDecision: "APPROVED",
          comments: [{ id: "unread", body: "Do not acknowledge yet" }],
          checks: kind === "null" ? null : [{ name: "ci", conclusion: "SUCCESS" }],
          totalChecks: kind === "incomplete" ? 2 : undefined,
        }),
      ],
    });
    expect(await run(["pr", "wait", "--timeout", "0"], worker.worktreePath)).toMatchObject({
      output: { reason: "pr_checks_unknown" },
    });
    expect(db.query("SELECT progress FROM pull_requests").all()).toEqual(before);
    expect((await shown(source)).pullRequests[0]?.parking).toBeNull();
  },
  120000,
);

test.each(["null", "incomplete"] as const)(
  "a parked %s check read preserves eligibility cursors and batch time through apparent restoration",
  async (kind) => {
    const { source, head } = await parkedFixture();
    const now = Date.now();
    const complete = pull({
      head,
      reviewDecision: "APPROVED",
      checks: [{ name: "ci", conclusion: "SUCCESS" }],
    });
    await github({ pulls: [complete] });
    await coordination(source, now);
    const before = (await shown(source)).pullRequests[0];
    const db = new Database(`${root}/state/operator/operator.sqlite`, { readonly: true });
    try {
      const receipt = db.query("SELECT progress, parking FROM pull_requests").all();
      const schedule = db.query("SELECT * FROM parked_pr_reads").all();
      await github({
        pulls: [
          {
            ...complete,
            reviewDecision: null,
            checks: kind === "null" ? null : complete.checks,
            totalChecks: kind === "incomplete" ? 2 : undefined,
          },
        ],
      });
      expect(await coordination(source, now + 900000, 3)).toMatchObject({
        reason: "github_invalid_response",
      });
      expect((await shown(source)).pullRequests[0]).toEqual(before);
      expect(db.query("SELECT progress, parking FROM pull_requests").all()).toEqual(receipt);
      expect(db.query("SELECT * FROM parked_pr_reads").all()).toEqual(schedule);
      await github({ pulls: [complete] });
      await coordination(source, now + 900001);
      expect((await shown(source)).pullRequests[0]).toEqual(before);
      expect(db.query("SELECT progress, parking FROM pull_requests").all()).toEqual(receipt);
    } finally {
      db.close();
    }
  },
  120000,
);
test.each(["comments", "threadComments"] as const)(
  "a repeated terminal %s page preserves the parked receipt and returns each feedback item only once after recovery",
  async (connection) => {
    const { source, head } = await parkedFixture();
    const now = Date.now();
    await coordination(source, now);
    const comments = Array.from({ length: 101 }, (_, index) => ({
      id: `C${index}`,
      body: `claim ${index}`,
      author: "person",
    }));
    const pr = pull({
      head,
      checks: [{ name: "ci", conclusion: "SUCCESS" }],
      ...(connection === "comments" ? { comments } : { threads: [{ id: "T", comments }] }),
    });
    using db = new Database(`${root}/state/operator/operator.sqlite`, { readonly: true });
    const receipt = db.query("SELECT progress, parking FROM pull_requests").all();
    const schedule = db.query("SELECT * FROM parked_pr_reads").all();
    await github({ pulls: [pr], repeatTerminal: connection });
    expect(await coordination(source, now + 900000, 3)).toMatchObject({
      reason: "github_invalid_response",
    });
    expect(db.query("SELECT progress, parking FROM pull_requests").all()).toEqual(receipt);
    expect(db.query("SELECT * FROM parked_pr_reads").all()).toEqual(schedule);
    await github({ pulls: [pr], repeatTerminal: null });
    await coordination(source, now + 900001);
    const savedParking = (await shown(source)).pullRequests[0]?.parking;
    const parking = z.object({ events: z.array(z.string()) }).parse(savedParking);
    const feedback = parking.events
      .map((event) =>
        z
          .object({ kind: z.string(), items: z.array(z.object({ id: z.string() })).optional() })
          .parse(JSON.parse(event)),
      )
      .flatMap((event) => event.items ?? []);
    expect(feedback.map((item) => item.id)).toEqual(comments.map((comment) => comment.id));
    await coordination(source, now + 1800001);
    expect((await shown(source)).pullRequests[0]?.parking).toEqual(savedParking);
  },
  120000,
);

test("a new same-head failed CI run is retained once after a previous failed generation", async () => {
  const { source, head } = await parkedFixture();
  const now = Date.now();
  await github({
    pulls: [pull({ head, checks: [{ id: "run1", name: "ci", conclusion: "FAILURE" }] })],
  });
  await coordination(source, now);
  expect(
    z.object({ events: z.array(z.string()) }).parse((await shown(source)).pullRequests[0]?.parking)
      .events,
  ).toHaveLength(1);
  await github({
    pulls: [pull({ head, checks: [{ id: "run2", name: "ci", conclusion: "FAILURE" }] })],
  });
  await coordination(source, now + 900000);
  expect(
    z.object({ events: z.array(z.string()) }).parse((await shown(source)).pullRequests[0]?.parking)
      .events,
  ).toHaveLength(2);
  await coordination(source, now + 1800000);
  expect(
    z.object({ events: z.array(z.string()) }).parse((await shown(source)).pullRequests[0]?.parking)
      .events,
  ).toHaveLength(2);
}, 120000);

test("a parked batch schedule survives successive coordination waits and quiet reads wake nothing", async () => {
  const { source } = await parkedFixture();
  const now = Date.now();
  await coordination(source, now);
  expect(await calls("gh-calls.jsonl", "ParkedPRs")).toBe(1);
  expect(await coordination(source, now + 899999)).toMatchObject({
    reason: "next_wait_timed_out",
    data: { sources: [] },
  });
  expect(await calls("gh-calls.jsonl", "ParkedPRs")).toBe(1);
  expect(await coordination(source, now + 900000)).toMatchObject({
    reason: "next_wait_timed_out",
    data: { sources: [] },
  });
  expect(await calls("gh-calls.jsonl", "ParkedPRs")).toBe(2);
  expect((await shown(source)).launches).toHaveLength(2);
}, 120000);

test.each(["feedback", "checks_failed"] as const)(
  "a parked %s event reaches a fresh actual feedback brief and its interrupted replacement",
  async (kind) => {
    const { source, worker, head } = await parkedFixture();
    const now = Date.now();
    await coordination(source, now);
    await github({
      pulls: [
        pull({
          head,
          ...(kind === "feedback"
            ? {
                comments: [
                  { id: "new-feedback", author: "person", body: "Please check the retry path." },
                ],
              }
            : { checks: [{ name: "ci", conclusion: "FAILURE" }] }),
        }),
      ],
    });
    const observed = await coordination(source, now + 900000);
    expect(observed).toMatchObject({
      reason: "next_actions_changed",
      data: {
        sources: [
          {
            actions: [
              {
                action: "resume_pr_feedback",
                reason: kind === "feedback" ? "pr_feedback" : "ci_failed",
                next: { command: `operator dispatch --source ${source} --assignment implement` },
              },
            ],
          },
        ],
      },
    });
    expect(await coordination(source, now + 1800000)).toMatchObject({
      reason: "next_wait_timed_out",
      data: { sources: [] },
    });
    const before = z
      .object({ events: z.array(z.string()) })
      .parse((await shown(source)).pullRequests[0]?.parking).events;
    expect(before).toHaveLength(1);
    expect(await run(["dispatch", "--source", source, "--assignment", "implement"])).toMatchObject({
      code: 0,
    });
    const first = await feedbackLaunch(source, 3);
    const brief = await Bun.file(worker.brief).text();
    expect(brief).toContain("## Events");
    expect(brief).toContain(
      kind === "feedback" ? "Please check the retry path." : '"kind":"checks_failed"',
    );
    expect(await run(["dispatch", "--source", source, "--assignment", "implement"])).toMatchObject({
      code: 4,
      output: { reason: "assignment_not_dispatchable" },
    });
    await exec(["herdr", "pane", "exit", first.launches.at(-1)?.paneId ?? "", "w"]);
    expect((await run(["dispatch", "--source", source, "--assignment", "implement"])).code).toBe(0);
    await feedbackLaunch(source, 4);
    expect(await Bun.file(worker.brief).text()).toContain(before[0] ?? "missing-event");
    expect(
      z
        .object({ events: z.array(z.string()) })
        .parse((await shown(source)).pullRequests[0]?.parking).events,
    ).toEqual(before);
    expect(await calls("gh-calls.jsonl", '"PUT"')).toBe(0);
    expect(await calls("gh-calls.jsonl", '"DELETE"')).toBe(0);
  },
  120000,
);

test("a failed parked resume keeps its events for the replacement without duplicate launches", async () => {
  const { source, worker, head } = await parkedFixture();
  await github({
    pulls: [
      pull({ head, comments: [{ id: "C1", body: "Keep this feedback.", author: "person" }] }),
    ],
  });
  await coordination(source, Date.now());
  const herdr = z
    .looseObject({ fail: z.record(z.string(), z.string()).optional() })
    .parse(await Bun.file(`${root}/herdr-state.json`).json());
  await Bun.write(
    `${root}/herdr-state.json`,
    JSON.stringify({ ...herdr, fail: { "agent start": "synthetic failure" } }),
  );
  expect((await run(["dispatch", "--source", source, "--assignment", "implement"])).code).not.toBe(
    0,
  );
  expect(await entry(source)).toMatchObject({ action: "replace_worker", reason: "launch_failed" });
  const failed = await shown(source);
  expect(failed.launches.at(-1)?.state).toBe("failed");
  const events = z
    .object({ events: z.array(z.string()) })
    .parse(failed.pullRequests[0]?.parking).events;
  expect(events).toHaveLength(1);
  const external = z.looseObject({}).parse(await Bun.file(`${root}/herdr-state.json`).json());
  await Bun.write(`${root}/herdr-state.json`, JSON.stringify({ ...external, fail: {} }));
  expect((await run(["dispatch", "--source", source, "--assignment", "implement"])).code).toBe(0);
  await feedbackLaunch(source, 4);
  expect(await Bun.file(worker.brief).text()).toContain("Keep this feedback.");
  expect(
    z.object({ events: z.array(z.string()) }).parse((await shown(source)).pullRequests[0]?.parking)
      .events,
  ).toEqual(events);
  expect(await calls("herdr-calls.jsonl", '"agent","start"')).toBe(4);
}, 120000);

test("an interrupted resume before reservation preserves its recorded events and next kind for recovery", async () => {
  const { source, worker, head } = await parkedFixture();
  await github({
    pulls: [
      pull({ head, comments: [{ id: "C1", body: "Recover this event.", author: "person" }] }),
    ],
  });
  await coordination(source, Date.now());
  await tool(
    "opencode",
    `#!${process.execPath}\nawait Bun.write(${JSON.stringify(`${root}/resume-entered`)}, "entered");\nawait Bun.sleep(500);\n${opencode.split("\n").slice(1).join("\n")}`,
  );
  const child = Bun.spawn(
    [process.execPath, cli, "dispatch", "--source", source, "--assignment", "implement", "--json"],
    { cwd: checkout, env: environment(), stdout: "pipe", stderr: "pipe" },
  );
  for (let tries = 0; tries < 200 && !(await Bun.file(`${root}/resume-entered`).exists()); tries++)
    await Bun.sleep(10);
  expect(await Bun.file(`${root}/resume-entered`).exists()).toBe(true);
  child.kill("SIGKILL");
  await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  await Bun.sleep(600);
  await tool("opencode", opencode);
  expect((await shown(source)).launches).toHaveLength(2);
  expect(await entry(source)).toMatchObject({ action: "replace_worker", reason: "handoff_failed" });
  expect((await run(["dispatch", "--source", source, "--assignment", "implement"])).code).toBe(0);
  await feedbackLaunch(source, 3);
  expect(await Bun.file(worker.brief).text()).toContain("Recover this event.");
  expect(await calls("herdr-calls.jsonl", '"agent","start"')).toBe(3);
}, 120000);

test("parking without a new note never reuses the reviewer's earlier ready note", async () => {
  const source = await setup("opencode");
  const { reviewer, brief, head } = await reviewing(source);
  expect((await run(["pr", "round", "--file", await findings([])], reviewer)).code).toBe(0);
  expect(
    (
      await run(
        ["pr", "ready", "--file", await summary("Reviewed.", []), "--note", "-"],
        reviewer,
        "Reviewer-only note.\n",
      )
    ).code,
  ).toBe(0);
  await feedbackLaunch(source);
  expect(await Bun.file(brief).text()).toContain("Reviewer-only note.");
  const checked = githubSchema.parse(await Bun.file(`${root}/github.json`).json());
  await github({
    pulls: checked.pulls.map((pr) => ({
      ...pr,
      number: 7,
      checks: [{ name: "ci", conclusion: "SUCCESS" }],
    })),
  });
  expect((await run(["pr", "wait", "--timeout", "0"], reviewer)).code).toBe(0);
  await latestWorker(source, reviewer, "finished", 3);
  const current = githubSchema.parse(await Bun.file(`${root}/github.json`).json());
  await github({
    pulls: current.pulls.map((pr) => ({
      ...pr,
      number: 7,
      head,
      comments: [{ id: "person", body: "A fresh claim.", author: "person" }],
    })),
  });
  await coordination(source, Date.now());
  expect((await run(["dispatch", "--source", source, "--assignment", "implement"])).code).toBe(0);
  await feedbackLaunch(source, 4);
  expect(await Bun.file(brief).text()).toContain("A fresh claim.");
  expect(await Bun.file(brief).text()).not.toContain("Reviewer-only note.");
  expect(await Bun.file(brief).text()).not.toContain("## Note");
}, 120000);

test("a parked PR closed without merge names abandon and abandonment preserves unlanded work", async () => {
  const { source, worker, head } = await parkedFixture();
  await Bun.write(`${worker.worktreePath}/unlanded.txt`, "keep this work\n");
  await github({ pulls: [pull({ head, state: "CLOSED" })] });
  expect(await coordination(source, Date.now())).toMatchObject({
    data: {
      sources: [
        {
          actions: expect.arrayContaining([
            expect.objectContaining({
              assignment: "implement",
              action: "clean_up",
              reason: "pr_closed",
              next: {
                command: `operator abandon --source ${source} --assignment implement`,
                why: "The PR closed without merge; retain its unlanded work.",
              },
              command: `operator abandon --source ${source} --assignment implement`,
            }),
          ]) as unknown,
        },
      ],
    },
  });
  expect((await run(["abandon", "--source", source, "--assignment", "implement"])).code).toBe(0);
  expect(await entry(source)).toMatchObject({
    action: "person_decision",
    reason: "cleanup_unlanded_work",
  });
  expect(await Bun.file(`${worker.worktreePath}/unlanded.txt`).text()).toBe("keep this work\n");
  expect(await git(checkout, "rev-parse", "refs/heads/task/12-implement")).toBe(head);
  expect(await calls("gh-calls.jsonl", '"DELETE"')).toBe(0);
  expect(await calls("gh-calls.jsonl", '"PUT"')).toBe(0);
}, 120000);

test.each(["missing commit", "foreign head"] as const)(
  "a parked merge with %s retains the assignment and all resources",
  async (kind) => {
    const { source, worker, head } = await parkedFixture();
    await github({
      pulls: [
        pull({
          head: kind === "foreign head" ? "unverified-head" : head,
          state: "MERGED",
          mergeCommit: kind === "missing commit" ? null : head,
        }),
      ],
    });
    await coordination(source, Date.now());
    expect(await entry(source)).toMatchObject({ action: "wait", reason: "pr_parked" });
    expect((await shown(source)).assignments.find((row) => row.key === "implement")?.state).toBe(
      "pr-open",
    );
    expect(await Bun.file(`${worker.worktreePath}/README.md`).exists()).toBe(true);
    expect(await git(checkout, "rev-parse", "refs/heads/task/12-implement")).toBe(head);
    expect(await calls("gh-calls.jsonl", '"DELETE"')).toBe(0);
    expect(await calls("gh-calls.jsonl", '"PUT"')).toBe(0);
    expect(await calls("herdr-calls.jsonl", '"pane","close"')).toBe(2);
    expect(await calls("herdr-calls.jsonl", '"agent","start"')).toBe(2);
  },
  120000,
);

test("a verified person merge of a parked PR ends the assignment and runs ordered cleanup without a new merge request", async () => {
  const { source, worker, head } = await parkedFixture();
  await github({ pulls: [pull({ head, state: "MERGED", mergeCommit: head })] });
  await coordination(source, Date.now());
  const shown = await run(["source", "show", "--source", source]);
  expect(shown).toMatchObject({
    code: 0,
    output: {
      data: {
        assignments: expect.arrayContaining([
          expect.objectContaining({ key: "implement", state: "merged" }),
        ]) as unknown,
        cleanups: [expect.objectContaining({ assignment: "implement", state: "done" })],
      },
    },
  });
  expect(await Bun.file(`${worker.worktreePath}/README.md`).exists()).toBe(false);
  expect(
    (await exec(["git", "show-ref", "--verify", "refs/heads/task/12-implement"])).code,
  ).not.toBe(0);
  expect(await calls("gh-calls.jsonl", '"PUT"')).toBe(0);
  expect(await calls("herdr-calls.jsonl", '"agent","start"')).toBe(2);
}, 120000);

async function latestWorker(source: string, worktree: string, state: string, attempt = 2) {
  let shownState = await shown(source);
  for (let tries = 0; tries < 150; tries++) {
    const launch = shownState.launches.findLast((row) => row.worktreePath === worktree);
    if (launch?.state === state && launch.attempt === attempt) {
      workerPanes.set(worktree, launch.paneId ?? "");
      return launch;
    }
    await Bun.sleep(50);
    shownState = await shown(source);
  }
  expect.unreachable(`No ${state} launch ${attempt} for ${worktree}`);
}

test("one actual batch reads every parked PR and a merged recorded parent wakes fresh feedback without branch effects", async () => {
  const source = await setup("opencode", {
    ...plan,
    assignments: plan.assignments.map((row) => ({
      ...row,
      dependencies: row.key === "second" ? ["implement"] : [],
    })),
  });
  await config({ internal: false });
  await git(checkout, "init", "--bare", `${root}/remote.git`);
  await git(checkout, "remote", "add", "fixture", `${root}/remote.git`);
  const parent = await dispatch(source);
  const parentHead = await commit(parent.worktreePath, "parent.txt");
  await git(parent.worktreePath, "push", "-u", "fixture", "task/12-implement");
  const parentPr = pull({ head: parentHead, checks: [{ name: "ci", conclusion: "SUCCESS" }] });
  await github({ pulls: [parentPr] });
  expect((await run(["pr", "associate"], parent.worktreePath)).code).toBe(0);
  await latestWorker(source, parent.worktreePath, "running");
  expect((await run(["pr", "wait", "--timeout", "0"], parent.worktreePath)).code).toBe(0);
  await latestWorker(source, parent.worktreePath, "finished");
  const child = await dispatch(source, "second");
  const childHead = await commit(child.worktreePath, "child.txt");
  const childPr = pull({
    number: 8,
    url: "https://github.com/example/one/pull/8",
    headRefName: "task/13-second",
    head: childHead,
    baseRefName: "task/12-implement",
    checks: [{ name: "ci", conclusion: "SUCCESS" }],
  });
  await github({ pulls: [parentPr, childPr] });
  expect((await run(["pr", "associate"], child.worktreePath)).code).toBe(0);
  await latestWorker(source, child.worktreePath, "running");
  expect((await run(["pr", "wait", "--timeout", "0"], child.worktreePath)).code).toBe(0);
  await latestWorker(source, child.worktreePath, "finished");
  const now = Date.now();
  await coordination(source, now);
  expect(await calls("gh-calls.jsonl", "ParkedPRs")).toBe(1);
  const reads = (await Bun.file(`${root}/gh-calls.jsonl`).text())
    .split("\n")
    .find((line) => line.includes("ParkedPRs"));
  expect(reads).toContain("pullRequest(number: 7)");
  expect(reads).toContain("pullRequest(number: 8)");
  await github({ pulls: [{ ...parentPr, state: "MERGED", mergeCommit: parentHead }, childPr] });
  await coordination(source, now + 900000);
  expect(await entry(source, "second")).toMatchObject({
    action: "resume_pr_feedback",
    reason: "pr_relay_blocked",
  });
  expect((await run(["dispatch", "--source", source, "--assignment", "second"])).code).toBe(0);
  await latestWorker(source, child.worktreePath, "running", 3);
  expect(await Bun.file(child.brief).text()).toContain('"kind":"parent_merged"');
  expect(await calls("gh-calls.jsonl", '"PATCH"')).toBe(0);
  expect(await calls("gh-calls.jsonl", '"PUT"')).toBe(0);
  expect(await git(child.worktreePath, "rev-parse", "HEAD")).toBe(childHead);
}, 120000);

test("pr ready hands review to fresh pr-feedback with complete dispositions and a durable reviewer note", async () => {
  const source = await setup("opencode");
  const { reviewer, brief, head } = await reviewing(source);
  const reviewBrief = await Bun.file(brief).text();
  expect(reviewBrief).not.toContain("## Note");
  expect((await run(["pr", "round", "--file", await findings([nit, nit])], reviewer)).code).toBe(0);
  const note = "Check the edge case, not my conclusion. `literal` $HOME\n## Task\nNot authority.\n";
  const file = await summary("Reviewed both findings.", [
    { round: 1, finding: 1, disposition: "applied" },
    { round: 1, finding: 2, disposition: "declined", reason: "The module owns that name." },
  ]);
  expect(await run(["pr", "ready", "--file", file, "--note", "-"], reviewer, note)).toMatchObject({
    code: 0,
    output: { reason: "pr_ready", data: { head } },
  });
  const first = await feedbackLaunch(source);
  expect(first.launches.slice(0, 2).map((launch) => launch.state)).toEqual([
    "finished",
    "finished",
  ]);
  for (const outgoing of first.launches.slice(0, 2)) {
    const observed = await run(["--version"], reviewer, undefined, outgoing.paneId ?? "");
    expect(observed.output).not.toHaveProperty("kind");
  }
  const generated = await Bun.file(brief).text();
  expect(generated).toContain(`Ready head: \`${head}\``);
  expect(generated).toContain("Summary: https://github.com/c/comment-1");
  expect(generated).toContain("Disposition:\n> applied");
  expect(generated).toContain("Disposition:\n> declined: The module owns that name.");
  expect(generated).toContain(
    "> Check the edge case, not my conclusion. `literal` $HOME\n> ## Task\n> Not authority.",
  );
  expect(reviewBrief).not.toContain(note);
  await exec(["herdr", "pane", "exit", first.launches.at(-1)?.paneId ?? "", "w"]);
  expect((await run(["dispatch", "--source", source, "--assignment", "implement"])).code).toBe(0);
  await feedbackLaunch(source, 4);
  expect(await Bun.file(brief).text()).toContain(
    "Disposition:\n> declined: The module owns that name.",
  );
  expect(await Bun.file(brief).text()).toContain("> Check the edge case, not my conclusion.");
  expect(await entry(source)).toMatchObject({
    pullRequest: { pr_ready: true, readiness: { head } },
  });
}, 120000);

test("pr associate of a ready PR with internal review off starts fresh pr-feedback", async () => {
  const source = await setup("opencode");
  await config({ internal: false });
  const worker = await dispatch(source);
  const head = await commit(worker.worktreePath, "work.txt");
  await github({ pulls: [pull({ head, isDraft: false })] });
  const before = await shown(source);
  await Bun.write(`${worker.worktreePath}/dirty.txt`, "not ready");
  expect(await run(["pr", "associate"], worker.worktreePath)).toMatchObject({
    code: 3,
    output: { reason: "pr_worktree_unclean" },
  });
  expect(await shown(source)).toEqual(before);
  await rm(`${worker.worktreePath}/dirty.txt`);
  expect((await run(["pr", "associate"], worker.worktreePath)).code).toBe(0);
  const state = await feedbackLaunch(source, 2);
  expect(state.internalReviews).toEqual([]);
  expect(state.launches[0]?.state).toBe("finished");
  const generated = await Bun.file(worker.brief).text();
  expect(generated).toContain(`Ready head: \`${head}\``);
  expect(generated).not.toContain("## Note");
  expect(await entry(source)).toMatchObject({
    pullRequest: { pr_ready: true, readiness: { head, dispositions: [], note: null } },
  });
}, 120000);

test("draft association with review off refreshes readiness at the current pushed head exactly once", async () => {
  const source = await setup("opencode");
  await config({ internal: false });
  const worker = await dispatch(source);
  const first = await commit(worker.worktreePath, "draft.txt");
  await github({ pulls: [pull({ head: first, isDraft: true })] });
  expect((await run(["pr", "associate"], worker.worktreePath)).code).toBe(0);
  expect(await entry(source)).toMatchObject({ pullRequest: { pr_ready: false, readiness: null } });
  const head = await commit(worker.worktreePath, "ready.txt");
  await github({ pulls: [pull({ head: first, isDraft: false })] });
  expect(await run(["pr", "associate"], worker.worktreePath)).toMatchObject({
    code: 3,
    output: { reason: "pr_worktree_unsynced" },
  });
  await github({ pulls: [pull({ head, isDraft: false })] });
  await Bun.write(`${worker.worktreePath}/dirty.txt`, "not ready");
  expect(await run(["pr", "associate"], worker.worktreePath)).toMatchObject({
    code: 3,
    output: { reason: "pr_worktree_unclean" },
  });
  await rm(`${worker.worktreePath}/dirty.txt`);
  await github({ pulls: [pull({ number: 8, head, isDraft: false })] });
  expect(await run(["pr", "associate"], worker.worktreePath)).toMatchObject({
    code: 4,
    output: { reason: "pr_already_associated" },
  });
  await github({ pulls: [pull({ head, isDraft: false })] });
  expect(await run(["pr", "associate"], worker.worktreePath)).toMatchObject({
    code: 0,
    output: { reason: "pr_associated" },
  });
  const feedback = await feedbackLaunch(source, 2);
  expect(feedback.launches[0]?.state).toBe("finished");
  expect(await entry(source)).toMatchObject({
    pullRequest: { pr_ready: true, readiness: { head } },
  });
  const before = await shown(source);
  expect(await run(["pr", "associate"], worker.worktreePath)).toMatchObject({
    code: 0,
    output: { reason: "pr_unchanged" },
  });
  expect(await shown(source)).toEqual(before);
}, 120000);

test.each(["custom", "legacy"] as const)(
  "ready association actually dispatches %s feedback without supervisor recovery",
  async (kind) => {
    const source = await setup("opencode", plan, kind);
    const worker = await dispatch(
      source,
      "implement",
      kind === "legacy" ? "implementation" : undefined,
    );
    const before = (await shown(source)).launches[0];
    if (kind === "legacy") expect(before?.kind).toMatchObject({ name: "implementation" });
    const head = await commit(worker.worktreePath, "ready.txt");
    await github({ pulls: [pull({ head, isDraft: false })] });
    expect(await run(["pr", "associate"], worker.worktreePath)).toMatchObject({ code: 0 });
    const state = await feedbackLaunch(source, 2);
    expect(state.launches[0]).toMatchObject({
      id: before?.id,
      state: "finished",
      kind: before?.kind,
    });
    expect(await entry(source)).toMatchObject({
      pullRequest: { pr_ready: true, readiness: { head } },
    });
    expect(await calls("herdr-calls.jsonl", "pane close")).toBeLessThanOrEqual(1);
  },
  120000,
);

test("the merge gate checks pr_ready and the observed draft state without merge effects", async () => {
  const source = await setup("opencode");
  await config({ internal: false });
  const worker = await dispatch(source);
  const head = await commit(worker.worktreePath, "work.txt");
  await github({ pulls: [pull({ head, isDraft: true })] });
  expect((await run(["pr", "associate"], worker.worktreePath)).code).toBe(0);
  await github({
    pulls: [
      pull({
        head,
        isDraft: false,
        reviewDecision: "APPROVED",
        checks: [{ name: "ci", conclusion: "SUCCESS" }],
      }),
    ],
  });
  const before = await shown(source);
  expect(await run(["pr", "merge"], worker.worktreePath)).toMatchObject({
    code: 3,
    output: {
      reason: "pr_merge_blocked",
      state: { conditions: { reviewEnded: false, notDraft: true } },
    },
  });
  expect(await shown(source)).toEqual(before);
  expect(await calls("gh-calls.jsonl", "enqueuePullRequest")).toBe(0);
  expect(await calls("gh-calls.jsonl", "mergePullRequest")).toBe(0);
}, 120000);

test("failed ready handoff replacement uses the saved note file and repeats no ready effects", async () => {
  const source = await setup("opencode");
  const { reviewer, brief, head } = await reviewing(source);
  expect((await run(["pr", "round", "--file", await findings([])], reviewer)).code).toBe(0);
  const summaryFile = await summary("No findings.", []);
  const before = await shown(source);
  await Bun.write(`${root}/long-note.md`, "line\n".repeat(61));
  expect(
    await run(["pr", "ready", "--file", summaryFile, "--note", `${root}/long-note.md`], reviewer),
  ).toMatchObject({ code: 3, output: { reason: "pr_note_invalid" } });
  expect(await shown(source)).toEqual(before);
  expect((await githubState()).readied).toBeUndefined();
  const note = `${root}/reviewer-note.md`;
  await Bun.write(note, "Recheck the public boundary.\n");
  const herdr = z.looseObject({}).parse(await Bun.file(`${root}/herdr-state.json`).json());
  await Bun.write(
    `${root}/herdr-state.json`,
    JSON.stringify({ ...herdr, fail: { "pane close": "controlled failure" } }),
  );
  expect(await run(["pr", "ready", "--file", summaryFile, "--note", note], reviewer)).toMatchObject(
    { code: 0, output: { reason: "pr_ready" } },
  );
  let row = await entry(source);
  for (let tries = 0; tries < 100 && row?.reason !== "handoff_failed"; tries++) {
    await Bun.sleep(50);
    row = await entry(source);
  }
  expect(row).toMatchObject({
    action: "replace_worker",
    reason: "handoff_failed",
    handoff: { nextKind: "pr-feedback" },
  });
  await rm(note);
  const failed = z.looseObject({}).parse(await Bun.file(`${root}/herdr-state.json`).json());
  await Bun.write(`${root}/herdr-state.json`, JSON.stringify({ ...failed, fail: {} }));
  expect((await run(["dispatch", "--source", source, "--assignment", "implement"])).code).toBe(0);
  await feedbackLaunch(source);
  expect(await Bun.file(brief).text()).toContain("## Note\n\n> Recheck the public boundary.");
  expect((await githubState()).readied).toEqual([7]);
  expect((await githubState()).commented).toHaveLength(1);
  await github({
    pulls: [
      pull({
        head,
        isDraft: true,
        reviewDecision: "APPROVED",
        checks: [{ name: "ci", conclusion: "SUCCESS" }],
      }),
    ],
  });
  const readyState = await shown(source);
  expect(await run(["pr", "merge"], reviewer)).toMatchObject({
    code: 3,
    output: {
      reason: "pr_merge_blocked",
      state: { conditions: { reviewEnded: true, notDraft: false } },
    },
  });
  expect(await shown(source)).toEqual(readyState);
  expect(await calls("gh-calls.jsonl", "enqueuePullRequest")).toBe(0);
}, 120000);

test("the reviewer ends the review with one rendered comment, the ready mutation, and its record", async () => {
  const source = await setup("opencode");
  await config({ assignments: true });
  const { reviewer, brief, head: first } = await reviewing(source);
  // The assignment reviewer waits for the ready transition, so it never comments on the draft.
  expect(await reviewRequests()).toEqual([]);

  expect(
    await run(["pr", "ready", "--file", await summary("Looks fine.", [])], reviewer),
  ).toMatchObject({ code: 3, output: { reason: "internal_review_round_missing" } });
  expect(
    await run(
      ["pr", "round", "--file", "-"],
      reviewer,
      await Bun.file(await findings([blocker, nit])).text(),
    ),
  ).toMatchObject({ code: 0 });

  await Bun.write(`${root}/summary.json`, '{"overview": "x", "dispositions": [{"round": 1}]}');
  expect(await run(["pr", "ready", "--file", `${root}/summary.json`], reviewer)).toMatchObject({
    code: 3,
    output: { reason: "internal_review_summary_invalid" },
  });
  const declinedWithoutReason = { round: 1, finding: 2, disposition: "declined" };
  const malformed = await run(
    ["pr", "ready", "--file", await summary("x", [declinedWithoutReason])],
    reviewer,
  );
  expect(malformed).toMatchObject({
    code: 3,
    output: {
      reason: "internal_review_summary_invalid",
      next: { command: "operator pr ready --file <path|->" },
    },
  });
  expect(malformed.stderr).toContain("Line 5");
  const applied = { round: 1, finding: 1, disposition: "applied" };
  const declined = { ...declinedWithoutReason, reason: "The name follows the module." };
  const incomplete = await run(["pr", "ready", "--file", await summary("x", [applied])], reviewer);
  expect(incomplete).toMatchObject({
    code: 3,
    output: { reason: "internal_review_summary_incomplete" },
  });
  expect(incomplete.stderr).toContain("Findings 1.2 have no disposition.");
  // The applied blocker of round 1 needs a review of its fix.
  expect(
    await run(["pr", "ready", "--file", await summary("x", [applied, declined])], reviewer),
  ).toMatchObject({ code: 3, output: { reason: "internal_review_second_round_required" } });

  // A person marks the draft ready outside Operator while the review runs.
  const second = await push(reviewer, "fix.txt", {
    isDraft: false,
    reviewDecision: "APPROVED",
    checks: [{ name: "ci", conclusion: "SUCCESS" }],
  });
  expect(await run(["pr", "round", "--file", await findings([])], reviewer)).toMatchObject({
    code: 0,
    output: { data: { round: 2, head: second } },
  });

  // An approved PR with passing checks is still not eligible while the review runs.
  expect(await run(["pr", "wait", "--timeout", "0"], reviewer)).toMatchObject({
    output: { reason: "pr_wait_timed_out", data: { mergeConditions: { reviewEnded: false } } },
  });
  expect(await run(["pr", "merge"], reviewer)).toMatchObject({
    code: 3,
    output: {
      reason: "pr_merge_blocked",
      blockers: [
        {
          detail:
            "The PR needs a recorded ready transition (pr_ready). Nothing was merged or changed.",
        },
      ],
    },
  });

  const overview = "The change does what the issue asks.\n\nThe review retained both decisions.";
  const file = await summary(overview, [applied, declined]);
  await Bun.write(`${reviewer}/notes.txt`, "unlanded\n");
  expect(await run(["pr", "ready", "--file", file], reviewer)).toMatchObject({
    code: 3,
    output: {
      reason: "pr_worktree_unclean",
      kind: "review",
      phase: "ready",
      next: { command: "git status --short" },
      state: { worktree_clean: false },
    },
  });
  await rm(`${reviewer}/notes.txt`);
  await commit(reviewer, "unpushed.txt");
  expect(await run(["pr", "ready", "--file", file], reviewer)).toMatchObject({
    code: 3,
    output: { reason: "pr_worktree_unsynced" },
  });
  // Each refusal changed nothing on GitHub.
  const untouched = await githubState();
  expect([untouched.commented, untouched.readied]).toEqual([undefined, undefined]);
  const third = await push(reviewer, "pushed.txt", {
    reviewDecision: "APPROVED",
    checks: [{ name: "ci", conclusion: "SUCCESS" }],
  });

  expect(
    await run(["pr", "ready", "--file", "-"], reviewer, await Bun.file(file).text()),
  ).toMatchObject({
    code: 0,
    output: {
      reason: "pr_ready",
      data: {
        number: 7,
        head: third,
        internalReview: { state: "ready", rounds: 2 },
        comment: { id: "comment-1", url: "https://github.com/c/comment-1" },
        assignmentReview: "queued",
      },
    },
  });
  const { commented, readied } = await githubState();
  expect(commented).toEqual([
    {
      id: "comment-1",
      number: 7,
      body: `**Internal review**: 2 rounds, at \`${third}\`.

${overview}

**Applied**

- **Spec**, blocker, \`a.ts:1\`: The guard is missing.

**Declined**

- **Skills**, nice-to-have, \`b.ts\`: Name it.
  Declined: The name follows the module.

<!-- operator-internal-review ${source}/implement -->
`,
    },
  ]);
  expect(readied).toEqual([7]);
  // The comment is posted before the PR leaves draft, so readers see it when they are notified.
  const log = await Bun.file(`${root}/gh-calls.jsonl`).text();
  expect(log.indexOf("/issues/7/comments")).toBeLessThan(
    log.indexOf("markPullRequestReadyForReview"),
  );

  expect(await entry(source)).toMatchObject({
    internalReview: {
      state: "ready",
      readyHead: third,
      comment: "https://github.com/c/comment-1",
      rounds: [{ head: first }, { head: second }],
    },
  });
  expect(await reviewRequests()).toMatchObject([
    { origin: "assignment", state: "queued", action: "start_reviewer" },
  ]);
  // The review ended, so the owner takes no more rounds and the gate now permits the merge.
  const ended = await feedbackLaunch(source);
  const reviewerPane = ended.launches.at(-1)?.paneId ?? "";
  const publicBefore = await githubState();
  expect(
    await run(["pr", "round", "--file", await findings([])], reviewer, undefined, reviewerPane),
  ).toMatchObject({
    code: 3,
    output: {
      reason: "internal_review_ended",
      phase: "feedback",
      next: { command: "operator pr wait" },
    },
  });
  expect(
    await run(["pr", "ready", "--file", file], reviewer, undefined, reviewerPane),
  ).toMatchObject({
    code: 3,
    output: {
      reason: "internal_review_ended",
      phase: "feedback",
      next: { command: "operator pr wait" },
    },
  });
  expect(await shown(source)).toEqual(ended);
  expect(await githubState()).toEqual(publicBefore);
  const eligible = await run(
    ["pr", "wait", "--timeout", "0"],
    reviewer,
    undefined,
    (await shown(source)).launches.at(-1)?.paneId ?? "",
  );
  expect(eligible).toMatchObject({
    output: {
      reason: "pr_events_observed",
      kind: "pr-feedback",
      phase: "feedback",
      next: { command: "operator pr wait" },
      data: { mergeConditions: { reviewEnded: true } },
    },
  });
  expect(JSON.stringify(eligible.output)).toContain(
    JSON.stringify({ kind: "merge_eligible", head: third }),
  );

  // A replacement after ready is the PR owner, from the recorded end, not from the draft state.
  await exec(["herdr", "pane", "exit", (await shown(source)).launches.at(-1)?.paneId ?? "", "w"]);
  expect(await entry(source)).toMatchObject({
    action: "replace_worker",
    reason: "worker_interrupted",
    internalReview: { state: "ready" },
  });
  expect((await run(["dispatch", "--source", source, "--assignment", "implement"])).code).toBe(0);
  const owner = await Bun.file(brief).text();
  expect(owner).toContain(`### Round 1 at \`${first}\``);
  expect(owner).toContain(`### Round 2 at \`${second}\``);
  expect(owner).toContain("Disposition:\n> applied");
  expect(owner).toContain("Disposition:\n> declined: The name follows the module.");
  expect(owner).toContain(`Review: \`ready\`.\nReady head: \`${third}\`.`);
  expect(owner).toContain("Summary: https://github.com/c/comment-1");
  expect(owner).toContain("Phase: `feedback`");
  expect(owner).not.toContain("You are the internal reviewer");
  const pane = (await shown(source)).launches.at(-1)?.paneId ?? "";
  const afterReady = await commit(reviewer, "after-ready.txt");
  expect(await run(["--version"], reviewer, undefined, pane)).toMatchObject({
    output: { phase: "feedback", next: { command: "operator pr wait" } },
  });
  expect(await run(["pr", "merge"], reviewer, undefined, pane)).toMatchObject({
    output: {
      reason: "pr_head_mismatch",
      phase: "feedback",
      next: { decider: "super-agent" },
      state: { localHead: afterReady, prHead: third },
    },
  });
  await github({
    mergeRefuse: true,
    pulls: [
      pull({
        head: afterReady,
        isDraft: false,
        reviewDecision: "APPROVED",
        checks: [{ name: "ci", conclusion: "SUCCESS" }],
      }),
    ],
  });
  expect(await run(["pr", "merge"], reviewer, undefined, pane)).toMatchObject({
    output: { reason: "pr_merge_refused", phase: "feedback" },
  });
}, 180000);

test("review input refuses malformed markdown and JSON before recording or publishing", async () => {
  const source = await setup("opencode");
  const { reviewer } = await reviewing(source);
  const invalidFindings: [string, number][] = [
    ['{"findings":[]}', 1],
    ["", 1],
    ["## Other\n", 1],
    ["## Findings\n## Findings\n", 2],
    ["## Findings\n- blocker, Security, a.ts:1: Claim.\n", 2],
    ["## Findings\n- blocker, Spec, : Claim.\n", 2],
    ["## Findings\n- blocker, Spec, a.ts:1:   \n", 2],
    ["## Findings\n- blocker, Spec, a.ts:1: Claim.\nextra\n", 3],
  ];
  for (const [text, line] of invalidFindings) {
    const result = await run(["pr", "round", "--file", "-"], reviewer, text);
    expect(result).toMatchObject({
      code: 3,
      output: {
        reason: "internal_review_findings_invalid",
        next: { command: "operator pr round --file <path|->" },
      },
    });
    expect(result.stderr).toContain(`Line ${line}:`);
  }
  expect(await entry(source)).toMatchObject({ internalReview: { rounds: [] } });
  expect(await run(["pr", "round", "--file", "-"], reviewer, "\r\n## Findings\r\n")).toMatchObject({
    code: 0,
    output: { data: { round: 1, findings: 0 } },
  });
  const invalidSummaries: [string, number][] = [
    ['{"overview":"fine","dispositions":[]}', 1],
    ["", 1],
    ["## Overview\nfine\n", 1],
    ["## Overview\n\n## Dispositions\n", 3],
    ["## Dispositions\n## Overview\nfine", 1],
    ["## Overview\nfine\n## Unknown\n", 3],
    ["## Overview\nfine\n## Overview\n", 3],
    ["## Overview\nfine\n## Dispositions\n## Dispositions\n", 4],
    ["## Overview\nfine\n## Dispositions\n- 0.1 applied\n", 4],
    ["## Overview\nfine\n## Dispositions\n- 1.0 applied\n", 4],
    ["## Overview\nfine\n## Dispositions\n- 9007199254740992.1 applied\n", 4],
    ["## Overview\nfine\n## Dispositions\n- 1.1 declined:   \n", 4],
    ["## Overview\nfine\n## Dispositions\n- 1.1 applied: extra\n", 4],
    ["## Overview\nfine\n## Dispositions\n- 1.1 ignored\n", 4],
  ];
  for (const [text, line] of invalidSummaries) {
    const result = await run(["pr", "ready", "--file", "-"], reviewer, text);
    expect(result).toMatchObject({
      code: 3,
      output: {
        reason: "internal_review_summary_invalid",
        next: { command: "operator pr ready --file <path|->" },
      },
    });
    expect(result.stderr).toContain(`Line ${line}:`);
  }
  const state = await githubState();
  expect([state.commented, state.readied, state.updated]).toEqual([
    undefined,
    undefined,
    undefined,
  ]);
  expect(await entry(source)).toMatchObject({
    internalReview: { state: "reviewing", rounds: [{ number: 1, findings: 0 }] },
  });
  expect(
    await run(
      ["pr", "ready", "--file", "-"],
      reviewer,
      "## Overview\r\nfine\r\n\r\n## Dispositions\r\n",
    ),
  ).toMatchObject({ code: 0, output: { reason: "pr_ready" } });
}, 180000);

test("the README round and ready stdin examples complete an isolated internal review", async () => {
  const source = await setup("opencode");
  const { reviewer } = await reviewing(source);
  const readme = await Bun.file(new URL("../../../README.md", import.meta.url)).text();
  const roundExample =
    /operator pr round --file - --json <<'EOF'\n[\s\S]*?\nEOF/.exec(readme)?.[0] ?? "";
  const readyExample =
    /operator pr ready --file - --json <<'EOF'\n[\s\S]*?\nEOF/.exec(readme)?.[0] ?? "";
  expect(roundExample).toContain("## Findings");
  expect(readyExample).toContain("## Overview");
  const round = await exec(["bash", "-c", roundExample], reviewer);
  expect(round.code, round.stderr).toBe(0);
  expect(JSON.parse(round.stdout) as unknown).toMatchObject({
    reason: "pr_round_recorded",
    data: { round: 1, findings: 0 },
  });
  const ready = await exec(["bash", "-c", readyExample], reviewer);
  expect(ready.code, ready.stderr).toBe(0);
  expect(JSON.parse(ready.stdout) as unknown).toMatchObject({ reason: "pr_ready" });
  expect((await githubState()).commented?.[0]?.body).toContain("The review found no issues.");
}, 180000);

test("a retry after a lost comment or ready answer posts one comment and records the end", async () => {
  const source = await setup("opencode");
  const { reviewer, head } = await reviewing(source);
  expect((await run(["pr", "round", "--file", await findings([nit])], reviewer)).code).toBe(0);
  const file = await summary("One nit.", [{ round: 1, finding: 1, disposition: "applied" }]);

  await github({ commentLost: true, readyLost: true });
  expect(await run(["pr", "ready", "--file", file], reviewer)).toMatchObject({
    code: 1,
    output: { reason: "github_uncertain" },
  });
  // The retry finds the comment by its marker, and the ready answer is lost too.
  expect(await run(["pr", "ready", "--file", file], reviewer)).toMatchObject({
    code: 1,
    output: { reason: "github_uncertain" },
  });
  expect(await entry(source)).toMatchObject({ internalReview: { state: "reviewing" } });
  expect(await run(["pr", "ready", "--file", file], reviewer)).toMatchObject({
    code: 0,
    output: { reason: "pr_ready", data: { head, comment: { id: "comment-1" } } },
  });
  const { commented, readied } = await githubState();
  expect(commented).toHaveLength(1);
  expect(readied).toEqual([7]);
}, 180000);

test("a retry after a later push updates the earlier comment to the new head and rounds", async () => {
  const source = await setup("opencode");
  const { reviewer, head } = await reviewing(source);
  expect((await run(["pr", "round", "--file", await findings([nit])], reviewer)).code).toBe(0);
  const first = await summary("One nit.", [{ round: 1, finding: 1, disposition: "applied" }]);
  await github({ commentLost: true });
  expect(await run(["pr", "ready", "--file", first], reviewer)).toMatchObject({
    code: 1,
    output: { reason: "github_uncertain" },
  });
  expect((await githubState()).commented?.[0]?.body).toContain(head);

  // The review still runs, so the reviewer pushes more work before it ends the review again.
  const { comments } = (await githubState()).pulls[0] ?? {};
  const later = await push(reviewer, "later.txt", { comments });
  const file = await summary("One nit, and a later fix.", [
    { round: 1, finding: 1, disposition: "applied" },
  ]);
  expect(await run(["pr", "ready", "--file", file], reviewer)).toMatchObject({
    code: 0,
    output: { reason: "pr_ready", data: { head: later, comment: { id: "comment-1" } } },
  });
  const { commented, updated, readied } = await githubState();
  expect(commented).toHaveLength(1);
  expect(updated).toHaveLength(1);
  expect(updated?.[0]).toMatchObject({ id: "comment-1" });
  expect(updated?.[0]?.body).toContain(`at \`${later}\``);
  expect(updated?.[0]?.body).toContain("One nit, and a later fix.");
  expect(readied).toEqual([7]);

  // A retry after the end refuses and changes nothing on GitHub.
  await feedbackLaunch(source);
  expect(await run(["pr", "ready", "--file", file], reviewer)).toMatchObject({
    output: { reason: "internal_review_ended" },
  });
  expect((await githubState()).updated).toHaveLength(1);
}, 180000);

test("an internal review skip runs at pr ready with no rounds or summary comment", async () => {
  const source = await setup("opencode");
  await config({ assignments: true });
  const { reviewer, head, brief } = await reviewing(source);
  const skip = ["internal-review", "skip", "--source", source, "--assignment", "implement"];

  expect(await run(skip)).toMatchObject({
    code: 3,
    output: {
      reason: "person_instruction_required",
      next: { decider: "person", question: "May this command run on your explicit instruction?" },
      state: { personInstructed: false },
    },
  });
  expect(
    await run([...skip.slice(0, 4), "--assignment", "second", "--person-instructed"]),
  ).toMatchObject({
    code: 3,
    output: {
      reason: "internal_review_not_recorded",
      next: { why: "No internal review exists to skip." },
      state: { review: null },
    },
  });
  expect(await calls("gh-calls.jsonl", "ReadyFacts")).toBe(0);

  expect(await run([...skip, "--person-instructed"])).toMatchObject({
    code: 0,
    output: {
      reason: "internal_review_skipped",
      next: { command: "operator pr ready" },
      data: { number: 7, head, internalReview: { state: "skipped" }, assignmentReview: null },
    },
  });
  const skipped = await githubState();
  expect([skipped.commented, skipped.readied]).toEqual([undefined, undefined]);
  expect(await run([...skip, "--person-instructed"])).toMatchObject({
    code: 3,
    output: { reason: "internal_review_ended" },
  });
  expect(await entry(source)).toMatchObject({
    internalReview: { state: "skipped", readyHead: null, comment: null },
  });
  expect(await reviewRequests()).toEqual([]);

  // Permission to skip is not readiness and creates no fresh launch until guarded ready.
  expect(await run(["pr", "round", "--file", await findings([])], reviewer)).toMatchObject({
    code: 3,
    output: { reason: "internal_review_ended", next: { command: "operator pr ready" } },
  });
  const reviewerPane = (await shown(source)).launches[1]?.paneId ?? "";
  const ended = await shown(source);
  const publicBefore = await githubState();
  await Bun.write(`${reviewer}/dirty.txt`, "not pushed");
  expect(await run(["pr", "ready"], reviewer)).toMatchObject({
    code: 3,
    output: { reason: "pr_worktree_unclean", phase: "ready" },
  });
  await rm(`${reviewer}/dirty.txt`);
  expect(await shown(source)).toEqual(ended);
  expect(await githubState()).toEqual(publicBefore);
  expect(await run(["pr", "merge"], reviewer, undefined, reviewerPane)).toMatchObject({
    output: { reason: "pr_merge_blocked", phase: "ready" },
  });
  await exec(["herdr", "pane", "exit", reviewerPane, "w"]);
  expect((await run(["dispatch", "--source", source, "--assignment", "implement"])).code).toBe(0);
  const replacementReview = (await shown(source)).launches.at(-1);
  expect(replacementReview).toMatchObject({ kind: { name: "review" }, state: "running" });
  workerPanes.set(reviewer, replacementReview?.paneId ?? "");
  expect(await Bun.file(brief).text()).toContain("Phase: `ready`");
  expect(await Bun.file(brief).text()).toContain(
    "Internal review was skipped on the person's instruction.",
  );
  expect(await Bun.file(brief).text()).not.toContain("## Note");
  expect(await run(["pr", "ready"], reviewer)).toMatchObject({
    code: 0,
    output: {
      reason: "pr_ready",
      data: { comment: null, internalReview: { state: "skipped", rounds: 0 } },
    },
  });
  const feedback = await feedbackLaunch(source, 4);
  const pane = feedback.launches.at(-1)?.paneId ?? "";
  expect(feedback.internalReviewRounds).toEqual([]);
  expect((await githubState()).commented).toBeUndefined();
  expect((await githubState()).readied).toEqual([7]);
  expect(await reviewRequests()).toMatchObject([{ origin: "assignment", state: "queued" }]);
  const once = await shown(source);
  const readyEffects = await githubState();
  expect(await run(["pr", "ready"], reviewer)).toMatchObject({
    code: 3,
    output: { reason: "internal_review_ended" },
  });
  expect(await shown(source)).toEqual(once);
  expect(await githubState()).toEqual(readyEffects);
  await github({ pulls: [pull({ head, isDraft: false, checks: [{ name: "ci" }] })] });
  expect(await run(["pr", "wait", "--timeout", "0"], reviewer, undefined, pane)).toMatchObject({
    code: 0,
    output: {
      reason: "pr_checks_running",
      kind: "pr-feedback",
      phase: "feedback",
      next: { command: "operator pr wait" },
      data: { mergeConditions: { reviewEnded: true, checksPassing: false } },
    },
  });
  await github({
    pulls: [
      pull({
        head,
        isDraft: false,
        reviewDecision: "APPROVED",
        checks: [{ name: "ci", conclusion: "SUCCESS" }],
      }),
    ],
  });
  const afterSkip = await commit(reviewer, "after-skip.txt");
  expect(await run(["--version"], reviewer, undefined, pane)).toMatchObject({
    output: { phase: "feedback", next: { command: "operator pr wait" } },
  });
  expect(await run(["pr", "merge"], reviewer, undefined, pane)).toMatchObject({
    output: {
      reason: "pr_head_mismatch",
      phase: "feedback",
      next: { decider: "super-agent" },
      state: { localHead: afterSkip, prHead: head },
    },
  });
  await github({
    mergeRefuse: true,
    pulls: [
      pull({
        head: afterSkip,
        isDraft: false,
        reviewDecision: "APPROVED",
        checks: [{ name: "ci", conclusion: "SUCCESS" }],
      }),
    ],
  });
  expect(await run(["pr", "merge"], reviewer, undefined, pane)).toMatchObject({
    output: { reason: "pr_merge_refused", phase: "feedback" },
  });
  await exec(["herdr", "pane", "exit", pane, "w"]);
  expect((await run(["dispatch", "--source", source, "--assignment", "implement"])).code).toBe(0);
  const replacement = await Bun.file(brief).text();
  expect(replacement).toContain("Phase: `feedback`");
  expect(replacement).toContain("Review: `skipped`.");
  expect(replacement).toContain("Internal review was skipped on the person's instruction.");
}, 180000);
