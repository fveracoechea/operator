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
async function github(change: { pulls?: Pull[]; commentLost?: boolean; readyLost?: boolean }) {
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

const nit = { axis: "Skills", severity: "nice-to-have", location: "b.ts", claim: "Name it." };

async function summary(overview: string, dispositions: object[]) {
  const file = `${root}/summary.json`;
  await Bun.write(file, JSON.stringify({ overview, dispositions }));
  return file;
}

async function config(review: { assignments?: boolean }) {
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
  return { reviewer: worker.worktreePath, brief: worker.brief, head };
}

/** The reviewer's push, which the fake GitHub reports as the PR head. */
async function push(reviewer: string, file: string, change: Record<string, unknown> = {}) {
  const head = await commit(reviewer, file);
  await github({ pulls: [pull({ head, isDraft: true, ...change })] });
  return head;
}

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
    await run(["pr", "round", "--file", await findings([blocker, nit])], reviewer),
  ).toMatchObject({ code: 0 });

  await Bun.write(`${root}/summary.json`, '{"overview": "x", "dispositions": [{"round": 1}]}');
  expect(await run(["pr", "ready", "--file", `${root}/summary.json`], reviewer)).toMatchObject({
    code: 3,
    output: { reason: "internal_review_summary_invalid" },
  });
  const declinedWithoutReason = { round: 1, finding: 2, disposition: "declined" };
  expect(
    await run(["pr", "ready", "--file", await summary("x", [declinedWithoutReason])], reviewer),
  ).toMatchObject({ code: 3, output: { reason: "internal_review_summary_invalid" } });
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
            "The PR needs an internal review that ended ready or skipped. Nothing was merged or changed.",
        },
      ],
    },
  });

  const overview = "The change does what the issue asks.";
  const file = await summary(overview, [applied, declined]);
  await Bun.write(`${reviewer}/notes.txt`, "unlanded\n");
  expect(await run(["pr", "ready", "--file", file], reviewer)).toMatchObject({
    code: 3,
    output: { reason: "pr_worktree_unclean" },
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

  expect(await run(["pr", "ready", "--file", file], reviewer)).toMatchObject({
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
  expect(await run(["pr", "round", "--file", await findings([])], reviewer)).toMatchObject({
    code: 3,
    output: { reason: "internal_review_ended" },
  });
  expect(await run(["pr", "ready", "--file", file], reviewer)).toMatchObject({
    code: 3,
    output: { reason: "internal_review_ended" },
  });
  const eligible = await run(["pr", "wait", "--timeout", "0"], reviewer);
  expect(eligible).toMatchObject({
    output: { reason: "pr_events_observed", data: { mergeConditions: { reviewEnded: true } } },
  });
  expect(JSON.stringify(eligible.output)).toContain(
    JSON.stringify({ kind: "merge_eligible", head: third }),
  );

  // A replacement after ready is the PR owner, from the recorded end, not from the draft state.
  await exec(["herdr", "pane", "exit", (await shown(source)).launches[1]?.paneId ?? "", "w"]);
  expect(await entry(source)).toMatchObject({
    action: "replace_worker",
    reason: "worker_interrupted",
    internalReview: { state: "ready" },
  });
  expect((await run(["dispatch", "--source", source, "--assignment", "implement"])).code).toBe(0);
  const owner = await Bun.file(brief).text();
  expect(owner).toContain(`The internal review of PR #7 ended ready at \`${third}\`.`);
  expect(owner).not.toContain("You are the internal reviewer");
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
  expect(await run(["pr", "ready", "--file", file], reviewer)).toMatchObject({
    output: { reason: "internal_review_ended" },
  });
  expect((await githubState()).updated).toHaveLength(1);
}, 180000);

test("a person-instructed skip ends the review with no comment, and the reviewer keeps the PR", async () => {
  const source = await setup("opencode");
  await config({ assignments: true });
  const { reviewer, head } = await reviewing(source);
  const skip = ["internal-review", "skip", "--source", source, "--assignment", "implement"];

  expect(await run(skip)).toMatchObject({
    code: 3,
    output: { reason: "person_instruction_required" },
  });
  expect(
    await run([...skip.slice(0, 4), "--assignment", "second", "--person-instructed"]),
  ).toMatchObject({ code: 3, output: { reason: "internal_review_not_recorded" } });
  expect(await calls("gh-calls.jsonl", "ReadyFacts")).toBe(0);

  expect(await run([...skip, "--person-instructed"])).toMatchObject({
    code: 0,
    output: {
      reason: "internal_review_skipped",
      data: { number: 7, head, internalReview: { state: "skipped" }, assignmentReview: "queued" },
    },
  });
  const skipped = await githubState();
  expect([skipped.commented, skipped.readied]).toEqual([undefined, [7]]);
  expect(await run([...skip, "--person-instructed"])).toMatchObject({
    code: 3,
    output: { reason: "internal_review_ended" },
  });
  expect(await entry(source)).toMatchObject({
    internalReview: { state: "skipped", readyHead: head, comment: null },
  });
  expect(await reviewRequests()).toMatchObject([{ origin: "assignment", state: "queued" }]);

  // The running reviewer learns of the skip from its next review command and owns the PR.
  const file = await summary("x", []);
  expect(await run(["pr", "ready", "--file", file], reviewer)).toMatchObject({
    code: 3,
    output: { reason: "internal_review_ended" },
  });
  expect(await run(["pr", "wait", "--timeout", "0"], reviewer)).toMatchObject({
    output: { data: { mergeConditions: { reviewEnded: true } } },
  });
}, 180000);
