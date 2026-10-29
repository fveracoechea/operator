import { afterEach, expect, test } from "bun:test";
// Bun has no temporary-directory, symlink, permission, or recursive removal API.
import { chmod, cp, mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { z } from "zod";
import { Environment } from "../environment/main.ts";
import { fakeHerdrScript } from "./herdr-fixture.ts";
import { fakeGithubScript } from "./github-fixture.ts";

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

async function githubReads() {
  const file = Bun.file(`${root}/gh-calls.jsonl`);
  if (!(await file.exists())) return 0;
  return (await file.text())
    .trim()
    .split("\n")
    .filter((line) => line.includes("graphql")).length;
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

function database() {
  return `${root}/state/operator/operator.sqlite`;
}

describeHosts();

function describeHosts() {
  for (const host of ["opencode", "claude-code"] as const)
    test(`${host}: the owner associates its PR and waits through feedback, CI, and eligibility`, async () => {
      const source = await setup(host);
      const worker = await dispatch(source);
      expect(await entry(source)).toMatchObject({ action: "wait", reason: "assignment_active" });

      expect(await run(["pr", "associate"], worker.worktreePath)).toMatchObject({
        code: 3,
        output: { reason: "pr_not_found" },
      });
      await github({ pulls: [pull()] });
      expect(await run(["pr", "associate"], worker.worktreePath)).toMatchObject({
        code: 0,
        output: {
          reason: "pr_associated",
          data: {
            assignment: "implement",
            number: 7,
            branch: "task/12-implement",
            state: "pr-open",
          },
        },
      });
      expect(await run(["pr", "associate"], worker.worktreePath)).toMatchObject({
        code: 0,
        output: { reason: "pr_unchanged" },
      });
      expect(await entry(source)).toMatchObject({
        action: "wait",
        reason: "pr_feedback_loop",
        pullRequest: { number: 7, wait: "idle" },
      });

      await github({
        pulls: [
          pull({
            reviews: [
              { id: "R1", state: "CHANGES_REQUESTED", body: "Fix the guard." },
              { id: "R2", state: "COMMENTED", body: "" },
            ],
            comments: [{ id: "C1", body: "Own reply.", author: "owner" }],
            threads: [{ comments: [{ id: "T1", body: "Wrong branch here." }], path: "a.ts" }],
            checks: [{ name: "lint" }],
          }),
        ],
      });
      const feedback = await run(["pr", "wait", "--timeout", "0"], worker.worktreePath);
      expect(feedback).toMatchObject({
        code: 0,
        output: {
          reason: "pr_events_observed",
          data: {
            number: 7,
            mergeConditions: {
              approved: false,
              checksPassing: false,
              threadsResolved: false,
              defaultBase: true,
            },
            events: [
              {
                kind: "feedback",
                items: [
                  { id: "R1", kind: "review", reviewState: "CHANGES_REQUESTED", fromViewer: false },
                  { id: "C1", kind: "comment", fromViewer: true },
                  { id: "T1", kind: "thread_comment", path: "a.ts", threadResolved: false },
                ],
              },
            ],
          },
        },
      });
      expect(await entry(source)).toMatchObject({
        reason: "pr_feedback_loop",
        pullRequest: { wait: "reported" },
      });

      // A new process continues from recorded progress and does not repeat the feedback.
      const repeated = await run(["pr", "wait", "--timeout", "0"], worker.worktreePath);
      expect(repeated).toMatchObject({
        code: 0,
        output: { reason: "pr_wait_timed_out", data: { events: [] } },
      });
      expect(await entry(source)).toMatchObject({
        action: "owner_attention",
        reason: "pr_wait_timed_out",
        pullRequest: { wait: "timed_out" },
      });

      await github({
        queue: [
          {
            checks: [
              { name: "lint", conclusion: "FAILURE" },
              { name: "legacy", status: "SUCCESS" },
            ],
          },
        ],
      });
      expect(await run(["pr", "wait", "--timeout", "0"], worker.worktreePath)).toMatchObject({
        output: {
          reason: "pr_events_observed",
          data: {
            events: [
              {
                kind: "checks_failed",
                head: "head-1",
                checks: [{ name: "lint", state: "failing" }],
              },
            ],
          },
        },
      });
      expect(await entry(source)).toMatchObject({ action: "wait", reason: "pr_feedback_loop" });
      expect(await run(["pr", "wait", "--timeout", "0"], worker.worktreePath)).toMatchObject({
        output: { reason: "pr_wait_timed_out" },
      });
      // The same check failing on a new head is new evidence.
      await github({ queue: [{ head: "head-2" }] });
      expect(await run(["pr", "wait", "--timeout", "0"], worker.worktreePath)).toMatchObject({
        output: { data: { events: [{ kind: "checks_failed", head: "head-2" }] } },
      });

      await github({
        queue: [
          {
            reviewDecision: "APPROVED",
            reviews: [
              { id: "R1", state: "CHANGES_REQUESTED", body: "Fix the guard." },
              { id: "R3", state: "APPROVED", body: "" },
            ],
            threads: [{ comments: [{ id: "T1", body: "Wrong branch here." }], resolved: true }],
            checks: [{ name: "lint", conclusion: "SUCCESS" }],
          },
        ],
      });
      expect(await run(["pr", "wait", "--timeout", "0"], worker.worktreePath)).toMatchObject({
        output: {
          data: {
            mergeConditions: {
              approved: true,
              checksPassing: true,
              threadsResolved: true,
              defaultBase: true,
            },
            events: [
              { kind: "feedback", items: [{ id: "R3", reviewState: "APPROVED" }] },
              { kind: "merge_eligible", head: "head-2" },
            ],
          },
        },
      });
      expect(await run(["pr", "wait", "--timeout", "0"], worker.worktreePath)).toMatchObject({
        output: { reason: "pr_wait_timed_out" },
      });

      // A merge seen by the wait is not a verified completion. The SuperAgent decides.
      await github({ queue: [{ state: "MERGED" }] });
      expect(await run(["pr", "wait", "--timeout", "0"], worker.worktreePath)).toMatchObject({
        code: 0,
        output: { reason: "pr_not_open", data: { events: [{ kind: "pr_merged" }] } },
      });
      expect(await entry(source)).toMatchObject({
        action: "owner_attention",
        reason: "pr_not_open",
      });
      const shown = await run(["source", "show", "--source", source]);
      expect(shown.output).toMatchObject({
        data: {
          state: "open",
          assignments: [
            { key: "implement", state: "pr-open" },
            { key: "second", state: "ready" },
          ],
          pullRequests: [{ assignment: "implement", number: 7, waitState: "not_open" }],
        },
      });
    }, 60000);
}

test("a wait polls until new feedback arrives and simultaneous waits report it once", async () => {
  const source = await setup("opencode");
  const worker = await dispatch(source);
  await github({ pulls: [pull()] });
  expect((await run(["pr", "associate"], worker.worktreePath)).code).toBe(0);
  await github({ queue: [{}, { comments: [{ id: "C1", body: "Later." }] }] });
  const polled = await run(["pr", "wait", "--timeout", "1"], worker.worktreePath);
  expect(polled).toMatchObject({
    output: {
      reason: "pr_events_observed",
      data: { events: [{ kind: "feedback", items: [{ id: "C1" }] }] },
    },
  });
  await github({
    queue: [
      {
        comments: [
          { id: "C1", body: "Later." },
          { id: "C2", body: "Again." },
        ],
      },
    ],
  });
  const both = await Promise.all([
    run(["pr", "wait", "--timeout", "0"], worker.worktreePath),
    run(["pr", "wait", "--timeout", "0"], worker.worktreePath),
  ]);
  expect(
    both.map((result) => z.object({ reason: z.string() }).parse(result.output).reason).toSorted(),
  ).toEqual(["pr_events_observed", "pr_wait_timed_out"]);
}, 60000);

test("PR commands resolve only the recorded worktree of the running owner and refuse without effects", async () => {
  const source = await setup("opencode");
  const worker = await dispatch(source);
  await github({ pulls: [pull()] });
  const before = await Bun.file(database()).arrayBuffer();
  const refusals: [string, string][] = [
    [checkout, "pr_worktree_unrecorded"],
    [root, "pr_worktree_unrecorded"],
  ];
  const clone = `${root}/clone`;
  await git(root, "clone", "-q", checkout, clone);
  await git(clone, "checkout", "-q", "-b", "task/12-implement");
  refusals.push([clone, "pr_worktree_unrecorded"]);
  for (const [cwd, reason] of refusals)
    for (const command of ["associate", "wait"])
      expect(await run(["pr", command], cwd)).toMatchObject({ code: 4, output: { reason } });
  expect(await run(["pr", "wait"], worker.worktreePath)).toMatchObject({
    code: 3,
    output: { reason: "pr_not_associated" },
  });
  // An assignment cannot be selected by flag.
  for (const flags of [
    ["--source", source],
    ["--assignment", "second"],
    ["--pr", "7"],
  ])
    expect(await run(["pr", "associate", ...flags], worker.worktreePath)).toMatchObject({
      code: 2,
      output: { reason: "invalid_arguments" },
    });
  await git(worker.worktreePath, "checkout", "-q", "-b", "elsewhere");
  expect(await run(["pr", "associate"], worker.worktreePath)).toMatchObject({
    code: 4,
    output: { reason: "pr_branch_mismatch" },
  });
  await git(worker.worktreePath, "checkout", "-q", "task/12-implement");
  await git(checkout, "remote", "set-url", "origin", "https://github.com/example/other.git");
  expect(await run(["pr", "associate"], worker.worktreePath)).toMatchObject({
    code: 4,
    output: { reason: "pr_repository_mismatch" },
  });
  await git(checkout, "remote", "set-url", "origin", "https://github.com/example/one.git");
  expect(await githubReads()).toBe(0);
  expect(await Bun.file(database()).arrayBuffer()).toEqual(before);

  // A subdirectory and a linked path resolve through the real Git top level.
  await mkdir(`${worker.worktreePath}/src`);
  await symlink(worker.worktreePath, `${root}/linked`);
  expect(await run(["pr", "associate"], `${worker.worktreePath}/src`)).toMatchObject({
    code: 0,
    output: { reason: "pr_associated" },
  });
  expect(await run(["pr", "associate"], `${root}/linked`)).toMatchObject({
    output: { reason: "pr_unchanged" },
  });

  // Another owner cannot claim the same PR, even from its own worktree.
  const second = await dispatch(source, "second");
  await github({ pulls: [pull(), pull({ headRefName: "task/13-second" })] });
  expect(await run(["pr", "associate"], second.worktreePath)).toMatchObject({
    code: 4,
    output: { reason: "pr_owned_elsewhere" },
  });
  // A fork with the same branch name is not the project's PR, and two PRs are ambiguous.
  await github({
    pulls: [pull(), pull({ number: 9, headRefName: "task/13-second", headRepository: "fork/one" })],
  });
  expect(await run(["pr", "associate"], second.worktreePath)).toMatchObject({
    code: 3,
    output: { reason: "pr_not_found" },
  });
  await github({
    pulls: [
      pull(),
      pull({ number: 9, headRefName: "task/13-second" }),
      pull({ number: 10, headRefName: "task/13-second" }),
    ],
  });
  expect(await run(["pr", "associate"], second.worktreePath)).toMatchObject({
    code: 3,
    output: { reason: "pr_ambiguous" },
  });
  expect(await entry(source, "second")).toMatchObject({ reason: "assignment_active" });

  // A different repository at the recorded path is refused.
  await rm(second.worktreePath, { recursive: true, force: true });
  await mkdir(second.worktreePath);
  await git(second.worktreePath, "init", "-q", "-b", "task/13-second");
  await git(second.worktreePath, "remote", "add", "origin", "https://github.com/example/one.git");
  const reads = await githubReads();
  expect(await run(["pr", "associate"], second.worktreePath)).toMatchObject({
    code: 4,
    output: { reason: "pr_repository_mismatch" },
  });
  expect(await githubReads()).toBe(reads);
}, 60000);

test("an interrupted owner needs replacement, and the replacement keeps the PR and its progress", async () => {
  const source = await setup("opencode");
  const worker = await dispatch(source);
  await github({ pulls: [pull({ comments: [{ id: "C1", body: "First." }] })] });
  expect((await run(["pr", "associate"], worker.worktreePath)).code).toBe(0);
  await Bun.write(`${worker.worktreePath}/unlanded.txt`, "partial work\n");
  expect((await run(["pr", "wait", "--timeout", "0"], worker.worktreePath)).output).toMatchObject({
    reason: "pr_events_observed",
  });
  await exec(["herdr", "pane", "exit", worker.paneId, "w1"]);
  expect(await entry(source)).toMatchObject({
    action: "replace_worker",
    reason: "worker_interrupted",
    pullRequest: { number: 7 },
  });
  const before = await Bun.file(database()).arrayBuffer();
  const reads = await githubReads();
  for (const command of ["associate", "wait"])
    expect(await run(["pr", command], worker.worktreePath)).toMatchObject({
      code: 4,
      output: { reason: "pr_owner_inactive" },
    });
  expect(await Bun.file(database()).arrayBuffer()).toEqual(before);
  expect(await githubReads()).toBe(reads);

  const replacement = await dispatch(source);
  expect(replacement.worktreePath).toBe(worker.worktreePath);
  expect(await Bun.file(`${worker.worktreePath}/unlanded.txt`).text()).toBe("partial work\n");
  const brief = await Bun.file(replacement.brief).text();
  expect(brief).toContain("PR #7 is already open for this assignment");
  expect(brief).not.toContain("operator pr associate");
  expect(await entry(source)).toMatchObject({ action: "wait", reason: "pr_feedback_loop" });
  expect(await run(["pr", "wait", "--timeout", "0"], replacement.worktreePath)).toMatchObject({
    output: { reason: "pr_wait_timed_out" },
  });
  const shown = await run(["source", "show", "--source", source]);
  expect(shown.output).toMatchObject({
    data: {
      assignments: [
        { key: "implement", state: "pr-open" },
        { key: "second", state: "ready" },
      ],
      launches: [
        { attempt: 1, state: "interrupted" },
        { attempt: 2, state: "running" },
      ],
    },
  });
}, 60000);

test("an unanswered GitHub read is a visible failure and records no wait result", async () => {
  const source = await setup("opencode");
  const worker = await dispatch(source);
  await github({ pulls: [pull()] });
  expect((await run(["pr", "associate"], worker.worktreePath)).code).toBe(0);
  await github({ fail: "upstream fault" });
  expect(await run(["pr", "wait", "--timeout", "0"], worker.worktreePath)).toMatchObject({
    code: 1,
    output: { reason: "github_uncertain" },
  });
  // The failed wait process ended, so its loop is visible as stopped.
  expect(await entry(source)).toMatchObject({
    action: "owner_attention",
    reason: "pr_wait_stopped",
    pullRequest: { wait: "stopped" },
  });
}, 60000);

async function activity(paneId: string, status: string) {
  const sent = await exec([
    "env",
    "HERDR_PLUGIN_EVENT=pane.agent_status_changed",
    `HERDR_PLUGIN_EVENT_JSON=${JSON.stringify({ event: "pane_agent_status_changed", data: { pane_id: paneId, agent_status: status } })}`,
    process.execPath,
    cli,
    "herdr",
    "event",
    "--json",
  ]);
  expect(sent.code, sent.stderr).toBe(0);
}

for (const [host, status] of [
  ["opencode", "idle"],
  ["claude-code", "done"],
] as const)
  test(`${host}: a worker that stops before its PR needs attention, then a replacement keeps its work`, async () => {
    const source = await setup(host);
    const worker = await dispatch(source);
    await Bun.write(`${worker.worktreePath}/partial.txt`, "partial work\n");
    await activity(worker.paneId, status);
    expect(await entry(source)).toMatchObject({
      action: "worker_attention",
      reason: "worker_idle",
      launch: { state: "running", observedActivity: { state: status } },
    });
    // The worker is live, so attention starts no second worker.
    const before = await Bun.file(database()).arrayBuffer();
    expect(await run(["dispatch", "--source", source, "--assignment", "implement"])).toMatchObject({
      code: 4,
      output: { reason: "assignment_not_dispatchable" },
    });
    expect(await Bun.file(database()).arrayBuffer()).toEqual(before);
    await activity(worker.paneId, "working");
    expect(await entry(source)).toMatchObject({ action: "wait", reason: "assignment_active" });

    // The worker lost its context. The SuperAgent ends its pane and replaces it.
    await activity(worker.paneId, status);
    await exec(["herdr", "pane", "exit", worker.paneId, "w1"]);
    expect(await entry(source)).toMatchObject({
      action: "replace_worker",
      reason: "worker_interrupted",
    });
    const replacement = await dispatch(source);
    expect(replacement.worktreePath).toBe(worker.worktreePath);
    expect(await Bun.file(`${worker.worktreePath}/partial.txt`).text()).toBe("partial work\n");
    expect(await entry(source)).toMatchObject({ action: "wait", reason: "assignment_active" });
    const shown = await run(["source", "show", "--source", source]);
    expect(shown.output).toMatchObject({
      data: {
        assignments: [{ key: "implement", state: "running" }, { key: "second" }],
        launches: [
          { attempt: 1, state: "interrupted" },
          { attempt: 2, state: "running" },
        ],
      },
    });
  }, 60000);

test("a killed wait and an idle owner between waits need attention", async () => {
  const source = await setup("opencode");
  const worker = await dispatch(source);
  await github({ pulls: [pull()] });
  expect((await run(["pr", "associate"], worker.worktreePath)).code).toBe(0);
  const child = Bun.spawn([process.execPath, cli, "pr", "wait", "--timeout", "600", "--json"], {
    cwd: worker.worktreePath,
    env: environment(),
    stdout: "pipe",
    stderr: "pipe",
  });
  const deadline = Date.now() + 20000;
  while (!JSON.stringify(await entry(source)).includes('"wait":"waiting"')) {
    expect(Date.now()).toBeLessThan(deadline);
    await Bun.sleep(100);
  }
  expect(await entry(source)).toMatchObject({ action: "wait", reason: "pr_feedback_loop" });
  // A running wait is working, even when the host reports idle.
  await activity(worker.paneId, "idle");
  expect(await entry(source)).toMatchObject({ reason: "pr_feedback_loop" });
  child.kill("SIGKILL");
  await child.exited;
  expect(await entry(source)).toMatchObject({
    action: "owner_attention",
    reason: "pr_wait_stopped",
    pullRequest: { wait: "stopped" },
  });

  await github({ queue: [{ comments: [{ id: "C1", body: "Fix it." }] }] });
  expect(await run(["pr", "wait", "--timeout", "0"], worker.worktreePath)).toMatchObject({
    output: { reason: "pr_events_observed" },
  });
  await activity(worker.paneId, "working");
  expect(await entry(source)).toMatchObject({ action: "wait", reason: "pr_feedback_loop" });
  await activity(worker.paneId, "done");
  expect(await entry(source)).toMatchObject({
    action: "owner_attention",
    reason: "pr_owner_idle",
  });
}, 60000);

async function setHerdr(change: Record<string, unknown>) {
  const file = Bun.file(`${root}/herdr-state.json`);
  const current: object = (await file.exists()) ? z.looseObject({}).parse(await file.json()) : {};
  await Bun.write(file, JSON.stringify({ ...current, ...change }));
}

test("a replacement after a failed replacement start continues on the PR worktree", async () => {
  const source = await setup("opencode");
  const worker = await dispatch(source);
  await github({ pulls: [pull()] });
  expect((await run(["pr", "associate"], worker.worktreePath)).code).toBe(0);
  await Bun.write(`${worker.worktreePath}/unlanded.txt`, "partial work\n");
  await exec(["herdr", "pane", "exit", worker.paneId, "w1"]);
  await setHerdr({ fail: { "worktree open": "herdr refused" } });
  expect(await run(["dispatch", "--source", source, "--assignment", "implement"])).toMatchObject({
    code: 1,
    output: { reason: "launch_failed" },
  });
  expect(await entry(source)).toMatchObject({ action: "replace_worker", reason: "launch_failed" });
  await setHerdr({ fail: {} });
  const third = await dispatch(source);
  expect(third.worktreePath).toBe(worker.worktreePath);
  expect(await git(third.worktreePath, "branch", "--show-current")).toBe("task/12-implement");
  expect(await Bun.file(`${third.worktreePath}/unlanded.txt`).text()).toBe("partial work\n");
  expect(await git(checkout, "branch", "--list", "task/12-implement-*")).toBe("");
  expect(await run(["pr", "wait", "--timeout", "0"], third.worktreePath)).toMatchObject({
    code: 0,
    output: { reason: "pr_wait_timed_out", data: { number: 7, branch: "task/12-implement" } },
  });

  // A missing PR worktree refuses dispatch instead of starting a new branch.
  await exec(["herdr", "pane", "exit", third.paneId, "w1"]);
  await rm(third.worktreePath, { recursive: true, force: true });
  const before = await Bun.file(database()).arrayBuffer();
  expect(await run(["dispatch", "--source", source, "--assignment", "implement"])).toMatchObject({
    code: 3,
    output: { reason: "pr_worktree_missing" },
  });
  expect(await Bun.file(database()).arrayBuffer()).toEqual(before);
  expect(await git(checkout, "branch", "--list", "task/12-implement-*")).toBe("");
}, 60000);
