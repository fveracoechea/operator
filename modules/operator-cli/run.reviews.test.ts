import { afterEach, expect, test } from "bun:test";
// Bun has no temporary-directory, symlink, permission, or recursive copy and removal API.
import { chmod, cp, mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { z } from "zod";
import { Environment } from "../environment/main.ts";
import { fakeGithubScript } from "./fake-github.ts";
import { fakeHerdrScript } from "./fake-herdr.ts";

let root = "";
let checkout = "";
let head = "";
const cli = Bun.fileURLToPath(new URL("../../cli.ts", import.meta.url));
const url = "https://github.com/example/one/pull/7";
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

async function exec(args: string[], cwd: string) {
  const child = Bun.spawn(args, { cwd, env: environment(), stdout: "pipe", stderr: "pipe" });
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { code, stdout, stderr };
}

/** Review commands run from the device root, which is no checkout, unless a test says otherwise. */
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

const claude = `#!${process.execPath}
for await (const chunk of Bun.stdin.stream().pipeThrough(new TextDecoderStream())) {
 for (const line of chunk.trim().split("\\n")) {
  const message=JSON.parse(line);
  if(message.type === "control_request") console.log(JSON.stringify({type:"control_response",response:{subtype:"success",request_id:message.request_id,response:{models:[{value:"precise-model",supportsEffort:true,supportedEffortLevels:["medium","high"]}],commands:[],agents:[]}}}));
 }
}
`;
const opencode = `#!${process.execPath}\nconst dir=decodeURIComponent(process.argv[4].split("=")[1]);\nconsole.log(JSON.stringify({location:{directory:dir},data:[{providerID:"test",id:"reasoner",enabled:true,variants:[{id:"medium"},{id:"high"}]}]}));\n`;

/**
 * A registered project whose origin is a local bare repository. The PR head exists only as
 * `refs/pull/7/head` there, as GitHub keeps it, so a reviewer must fetch it.
 */
async function setup(host: "opencode" | "claude-code" = "opencode") {
  root = await realpath(await mkdtemp(path.join(tmpdir(), "operator-review-")));
  checkout = `${root}/checkout`;
  const remote = `${root}/remote.git`;
  await mkdir(checkout);
  await git(root, "init", "-q", "--bare", remote);
  await git(checkout, "init", "-q", "-b", "main");
  await git(checkout, "remote", "add", "origin", "https://github.com/example/one.git");
  await Bun.write(`${checkout}/README.md`, "fixture\n");
  await git(checkout, "add", ".");
  await git(checkout, "commit", "-q", "-m", "fixture");
  await git(checkout, "push", "-q", remote, "main");
  await git(checkout, "switch", "-q", "-c", "feature");
  await Bun.write(`${checkout}/feature.ts`, "export const value = 1;\n");
  await git(checkout, "add", ".");
  await git(checkout, "commit", "-q", "-m", "feature");
  head = await git(checkout, "rev-parse", "HEAD");
  await git(checkout, "push", "-q", remote, "HEAD:refs/pull/7/head");
  await git(checkout, "switch", "-q", "main");
  await git(checkout, "branch", "-q", "-D", "feature");
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
      workerAgent:
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
  expect((await run(["project", "register"], checkout)).code).toBe(0);
  expect((await run(["herdr", "install"], checkout)).code).toBe(0);
  // Fetches from the GitHub remote reach the local bare repository after registration.
  await git(checkout, "config", `url.${remote}.insteadOf`, "https://github.com/example/one.git");
  await github({ pulls: [pull()] });
}

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

type Pull = Record<string, unknown> & { number: number };
function pull(change: object = {}): Pull {
  return {
    number: 7,
    url,
    state: "OPEN",
    head,
    author: "author",
    files: ["feature.ts"],
    ...change,
  };
}

async function github(change: object) {
  const file = Bun.file(`${root}/github.json`);
  const current: object = (await file.exists()) ? z.looseObject({}).parse(await file.json()) : {};
  await Bun.write(file, JSON.stringify({ ...current, ...change }));
}

const postedSchema = z.array(
  z.looseObject({ event: z.string(), body: z.string(), commit_id: z.string() }),
);
async function posted() {
  const file = Bun.file(`${root}/github.json`);
  return postedSchema.parse(
    z.looseObject({ posted: z.unknown().optional() }).parse(await file.json()).posted ?? [],
  );
}

async function herdrCalls() {
  const file = Bun.file(`${root}/herdr-calls.jsonl`);
  if (!(await file.exists())) return [];
  return (await file.text())
    .trim()
    .split("\n")
    .map((line) => z.array(z.string()).parse(JSON.parse(line)));
}

function database() {
  return `${root}/state/operator/operator.sqlite`;
}

const requestSchema = z.looseObject({
  state: z.string(),
  draft: z.string(),
  brief: z.string(),
  reviewer: z
    .looseObject({ worktreePath: z.string().nullable(), branch: z.string().nullable() })
    .nullable(),
});

async function add() {
  const added = await run(["review", "add", url]);
  expect(added.code, added.stderr).toBe(0);
  return z.object({ data: requestSchema }).parse(added.output).data;
}

async function draft(file: string, change: object = {}) {
  await Bun.write(
    file,
    JSON.stringify({
      reviewedCommit: head,
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

for (const host of ["opencode", "claude-code"] as const)
  test(`${host}: a manual request reviews the PR repository from any folder and posts once`, async () => {
    await setup(host);
    const request = await add();
    expect(request).toMatchObject({ state: "queued", reviewer: null });
    expect(await run(["review", "add", url])).toMatchObject({
      code: 0,
      output: { reason: "review_unchanged" },
    });
    expect(await next()).toMatchObject([
      { state: "queued", action: "start_reviewer", command: `operator review start ${url}` },
    ]);

    const started = await run(["review", "start", url]);
    expect(started.code, started.stderr).toBe(0);
    const reviewer = z
      .object({
        data: z.object({
          launch: z.object({ worktreePath: z.string(), branch: z.string(), brief: z.string() }),
        }),
      })
      .parse(started.output).data.launch;
    expect(reviewer.branch).toBe("review/one-pr-7");
    expect(await git(reviewer.worktreePath, "rev-parse", "HEAD")).toBe(head);
    expect(await git(reviewer.worktreePath, "symbolic-ref", "--short", "HEAD")).toBe(
      "review/one-pr-7",
    );
    expect(reviewer.brief).toBe(request.brief);
    const brief = await Bun.file(reviewer.brief).text();
    expect(brief).toContain(request.draft);
    expect(brief).toContain(`operator review post ${url} --json`);
    expect(brief).toContain(`at the PR head \`${head}\` on the local branch \`review/one-pr-7\``);
    // The reviewer worktree belongs to the PR repository's workspace, not the caller's folder.
    const calls = await herdrCalls();
    const created = calls.find((call) => call.slice(0, 2).join(" ") === "worktree create");
    expect(created).toContain("--base");
    expect(created).toContain(head);
    const workspace = z
      .object({
        workspaces: z.array(
          z.object({ workspace_id: z.string(), worktree: z.object({ checkout_path: z.string() }) }),
        ),
      })
      .parse(await Bun.file(`${root}/herdr-state.json`).json())
      .workspaces.find((row) => row.worktree.checkout_path === checkout);
    expect(created?.[created.indexOf("--workspace") + 1]).toBe(workspace?.workspace_id);
    expect(calls.some((call) => call[0] === "agent" && call[1] === "start")).toBe(true);
    expect(await next()).toMatchObject([{ state: "reviewing", wait: "review_draft" }]);
    expect(await run(["review", "start", url])).toMatchObject({
      code: 4,
      output: { reason: "review_reviewer_started" },
    });

    await draft(request.draft);
    const done = await run(["review", "post", url]);
    expect(done).toMatchObject({
      code: 0,
      output: {
        reason: "review_posted",
        data: { event: "APPROVE", state: "approved", blockers: 0 },
      },
    });
    const reviews = await posted();
    expect(reviews).toHaveLength(1);
    expect(reviews[0]).toMatchObject({ event: "APPROVE", commit_id: head });
    expect(reviews[0]?.body).toContain("**Approved**");
    expect(reviews[0]?.body).toContain("Reported test: `bun test feature.test.ts` exited 0.");
    expect(await next()).toEqual([]);

    // Operator pushes no reviewer branch.
    expect(await git(`${root}/remote.git`, "for-each-ref", "--format=%(refname)")).not.toContain(
      "review/",
    );
  }, 60000);

test("the event follows blockers, named breaches, required CI, and the posting account", async () => {
  await setup();
  const request = await add();
  await draft(request.draft, {
    blockers: [
      {
        short: "Guard has no test",
        detail: "Add a test for the new guard.",
        path: "feature.ts",
        line: 1,
      },
    ],
    niceToHaves: [{ detail: "Name the constant for its use." }],
  });
  expect(await run(["review", "post", url])).toMatchObject({
    code: 0,
    output: { data: { event: "COMMENT", state: "watching", blockers: 1, niceToHaves: 1 } },
  });
  const [comment] = await posted();
  expect(comment?.body).toContain("**Needs changes** · 1 blocker, 1 nice to have");
  expect(comment).toMatchObject({
    comments: [
      {
        path: "feature.ts",
        line: 1,
        side: "RIGHT",
        body: "Blocker. Guard has no test. Add a test for the new guard.",
      },
    ],
  });
  expect(await next()).toMatchObject([{ state: "watching", wait: "review_watching" }]);
  // A second post of the same round is refused before any GitHub write.
  expect(await run(["review", "post", url])).toMatchObject({
    code: 4,
    output: { reason: "review_already_posted" },
  });
  expect(await posted()).toHaveLength(1);
}, 60000);

test("a named strong breach requests changes, except on the posting account's own PR", async () => {
  await setup();
  const breach = {
    blockers: [
      {
        short: "Helper has no owner",
        detail: "Move it into the module that calls it.",
        breach: { source: "opinions", rule: "A helper is a module that was not named." },
      },
    ],
  };
  const request = await add();
  await draft(request.draft, breach);
  expect(await run(["review", "post", url])).toMatchObject({
    output: { data: { event: "REQUEST_CHANGES" } },
  });
  expect((await posted())[0]?.body).toContain(
    "Strong breach of the opinions: A helper is a module that was not named.",
  );

  await setup();
  await github({ viewer: "author" });
  const own = await add();
  await draft(own.draft, breach);
  expect(await run(["review", "post", url])).toMatchObject({
    output: { data: { event: "COMMENT" } },
  });
  await setup();
  await github({ viewer: "author" });
  const clean = await add();
  await draft(clean.draft);
  expect(await run(["review", "post", url])).toMatchObject({
    output: { data: { event: "COMMENT", state: "watching" } },
  });
  expect((await posted())[0]?.body).toContain("No blockers.");
}, 60000);

test("required CI failures are blockers, and a noise claim cannot cite a changed file", async () => {
  await setup();
  await github({
    pulls: [
      pull({
        checks: [
          { name: "unit", conclusion: "FAILURE", required: true },
          { name: "lint", conclusion: "FAILURE", required: true },
          { name: "optional", conclusion: "FAILURE" },
          { name: "build", required: true },
        ],
      }),
    ],
  });
  const request = await add();
  await draft(request.draft, {
    noise: [{ check: "lint", files: ["feature.ts"], reason: "It fails on main too." }],
  });
  const before = await Bun.file(database()).arrayBuffer();
  expect(await run(["review", "post", url])).toMatchObject({
    code: 3,
    output: { reason: "review_noise_changed_file" },
  });
  expect(await Bun.file(database()).arrayBuffer()).toEqual(before);
  expect(await posted()).toEqual([]);

  await draft(request.draft, {
    noise: [{ check: "lint", files: ["legacy/old.ts"], reason: "It fails on main too." }],
  });
  expect(await run(["review", "post", url])).toMatchObject({
    output: { data: { event: "COMMENT", blockers: 1 } },
  });
  const [review] = await posted();
  expect(review?.body).toContain("**CI check unit fails.** https://ci/unit");
  expect(review?.body).toContain("Required CI: 3 checks, 1 failing, 1 pending.");
  expect(review?.body).toContain("Noise: `lint` fails only in files that this PR does not change");
  expect(review?.body).not.toContain("optional");
}, 60000);

test("a repository with no required CI gets only the reported checks", async () => {
  await setup();
  const request = await add();
  await draft(request.draft, {
    checks: [{ kind: "guard-break", command: "bun test --break guard", exitCode: 1 }],
  });
  expect(await run(["review", "post", url])).toMatchObject({
    output: { data: { event: "APPROVE" } },
  });
  const [review] = await posted();
  expect(review?.body).toContain("No required CI check reports on this PR.");
  expect(review?.body).toContain("Reported guard-break: `bun test --break guard` exited 1.");
}, 60000);

test("draft refusals post nothing and change nothing", async () => {
  await setup();
  const request = await add();
  const before = await Bun.file(database()).arrayBuffer();
  const cases: [object | string | null, string][] = [
    [null, "review_draft_missing"],
    ["{", "review_draft_invalid"],
    [{ event: "APPROVE" }, "review_draft_invalid"],
    [{ reviewedCommit: "abc" }, "review_draft_invalid"],
    [
      { blockers: [1, 2, 3, 4].map(() => ({ short: "Broken", detail: "Broken." })) },
      "review_draft_invalid",
    ],
    [{ niceToHaves: [1, 2, 3, 4].map(() => ({ detail: "Later." })) }, "review_draft_invalid"],
    [
      { blockers: [{ short: "This short text has seven words now", detail: "Too long." }] },
      "review_draft_invalid",
    ],
    [
      { blockers: [{ short: "Wrong file", detail: "Elsewhere.", path: "other.ts", line: 2 }] },
      "review_draft_invalid",
    ],
    [
      { checks: [{ kind: "guard-break", command: "bun test", exitCode: 0 }] },
      "review_draft_invalid",
    ],
    [{ reviewedCommit: "0".repeat(40) }, "review_head_moved"],
    [
      { noise: [{ check: "absent", files: ["x.ts"], reason: "None." }] },
      "review_noise_unknown_check",
    ],
    [{ threadReplies: [{ threadId: "PRRT_missing", body: "Fixed." }] }, "review_thread_unknown"],
  ];
  for (const [change, reason] of cases) {
    if (change === null) await rm(request.draft, { force: true });
    else if (typeof change === "string") await Bun.write(request.draft, change);
    else await draft(request.draft, change);
    const refused = await run(["review", "post", url]);
    expect(refused.output, reason).toMatchObject({ reason });
    expect(refused.code).toBe(reason === "review_head_moved" ? 4 : 3);
  }
  // A valid reply to this account's own thread waits for the round flow that posts replies.
  await github({
    pulls: [
      pull({
        threads: [{ id: "PRRT_own", comments: [{ id: "T1", body: "Old.", author: "owner" }] }],
      }),
    ],
  });
  await draft(request.draft, { threadReplies: [{ threadId: "PRRT_own", body: "Fixed now." }] });
  expect(await run(["review", "post", url])).toMatchObject({
    output: { reason: "review_thread_replies_unsupported" },
  });
  expect(await Bun.file(database()).arrayBuffer()).toEqual(before);
  expect(await posted()).toEqual([]);
  expect(await next()).toMatchObject([{ state: "queued" }]);
}, 60000);

test("two simultaneous posts reach GitHub once, and a lost answer is found, not repeated", async () => {
  await setup();
  const request = await add();
  await draft(request.draft);
  await github({ postDelayMs: 1500 });
  const [first, second] = await Promise.all([
    run(["review", "post", url]),
    Bun.sleep(400).then(() => run(["review", "post", url])),
  ]);
  // Either process can take the lease first. Exactly one posts.
  const results = [first, second].map((result) => ({
    code: result.code,
    reason: result.output.reason,
  }));
  expect(results).toContainEqual({ code: 0, reason: "review_posted" });
  expect(results).toContainEqual({ code: 4, reason: "review_post_in_progress" });
  expect(await posted()).toHaveLength(1);

  await setup();
  const lost = await add();
  await draft(lost.draft);
  await github({ postUncertain: true });
  expect(await run(["review", "post", url])).toMatchObject({
    code: 1,
    output: { reason: "github_uncertain" },
  });
  expect(await next()).toMatchObject([
    { state: "posting", action: "post_review", reason: "review_post_uncertain" },
  ]);
  expect(await run(["review", "post", url])).toMatchObject({
    code: 0,
    output: { reason: "review_posted", data: { state: "approved" } },
  });
  expect(await posted()).toHaveLength(1);
}, 60000);

test("a refused post returns the request for a corrected draft", async () => {
  await setup();
  const request = await add();
  await draft(request.draft);
  await github({ postFail: "Line could not be resolved" });
  expect(await run(["review", "post", url])).toMatchObject({
    code: 1,
    output: { reason: "review_post_failed" },
  });
  expect(await next()).toMatchObject([{ state: "queued", action: "start_reviewer" }]);
  await github({ postFail: null });
  expect(await run(["review", "post", url])).toMatchObject({ output: { reason: "review_posted" } });
  expect(await posted()).toHaveLength(1);
}, 60000);

test("an unregistered or closed PR is refused without the caller's project context", async () => {
  await setup();
  const before = await Bun.file(database()).arrayBuffer();
  const herdrBefore = await herdrCalls();
  const other = "https://github.com/example/two/pull/3";
  await github({ pulls: [pull(), pull({ number: 3, url: other })] });
  for (const args of [
    ["review", "add", other],
    ["review", "start", other],
  ])
    expect(await run(args, checkout)).toMatchObject({
      code: 3,
      output: { reason: "review_repository_unregistered" },
    });
  expect(await run(["review", "add", "https://gitlab.com/example/one/pull/7"])).toMatchObject({
    code: 2,
    output: { reason: "review_url_invalid" },
  });
  await github({ pulls: [pull({ state: "MERGED" })] });
  expect(await run(["review", "add", url])).toMatchObject({
    code: 3,
    output: { reason: "review_pr_not_open" },
  });
  expect(await Bun.file(database()).arrayBuffer()).toEqual(before);
  expect(await herdrCalls()).toEqual(herdrBefore);
}, 60000);

test("a reviewer start that fails stays visible and a retry reuses its recorded worktree", async () => {
  await setup();
  const request = await add();
  const herdrState = `${root}/herdr-state.json`;
  const current: object = z.looseObject({}).parse(await Bun.file(herdrState).json());
  await Bun.write(
    herdrState,
    JSON.stringify({ ...current, fail: { "agent start": "host refused" } }),
  );
  expect(await run(["review", "start", url])).toMatchObject({
    code: 1,
    output: { reason: "launch_failed" },
  });
  const [failed] = await next();
  expect(failed).toMatchObject({
    state: "queued",
    action: "start_reviewer",
    reason: "launch_failed",
    reviewer: { state: "failed", failure: { reason: "herdr_failed" } },
  });
  const worktree = requestSchema.parse(failed).reviewer?.worktreePath ?? "";
  expect(worktree).not.toBe("");
  await Bun.write(herdrState, JSON.stringify({ ...current, fail: {} }));
  const retried = await run(["review", "start", url]);
  expect(retried.code, retried.stderr).toBe(0);
  expect(retried.output).toMatchObject({ data: { launch: { worktreePath: worktree } } });
  expect(
    (await herdrCalls()).filter((call) => call.slice(0, 2).join(" ") === "worktree create"),
  ).toHaveLength(1);
  expect(request.state).toBe("queued");
}, 60000);

// The fetch redirect hides the GitHub remote from project commands, so they run without it.
async function withoutFetchRedirect() {
  await git(checkout, "config", "--remove-section", `url.${root}/remote.git`);
}

test("an enabled assignment reviewer is queued at PR association and always comments", async () => {
  await setup();
  await withoutFetchRedirect();
  const settings: object = z
    .looseObject({})
    .parse(await Bun.file(`${root}/config/operator/config.json`).json());
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
    ],
  };
  await Bun.write(`${root}/plan.json`, JSON.stringify(plan));
  const registered = await run(["source", "register", "--file", `${root}/plan.json`], checkout);
  const source = z.object({ data: z.object({ id: z.string() }) }).parse(registered.output).data.id;
  const dispatched = await run(
    ["dispatch", "--source", source, "--assignment", "implement"],
    checkout,
  );
  expect(dispatched.code, dispatched.stderr).toBe(0);
  const worktree = z
    .object({ data: z.object({ worktreePath: z.string() }) })
    .parse(dispatched.output).data.worktreePath;
  const assigned = { headRefName: "task/12-implement", headRepository: "example/one" };
  await github({ pulls: [pull(assigned)], viewer: "owner" });

  // Off by default: association queues no review request.
  expect(await run(["pr", "associate"], worktree)).toMatchObject({ code: 0 });
  expect(await next()).toEqual([]);

  await setup();
  await withoutFetchRedirect();
  await Bun.write(
    `${root}/config/operator/config.json`,
    JSON.stringify({ ...settings, review: { assignments: true } }),
  );
  await Bun.write(`${root}/plan.json`, JSON.stringify(plan));
  const again = await run(["source", "register", "--file", `${root}/plan.json`], checkout);
  const second = z.object({ data: z.object({ id: z.string() }) }).parse(again.output).data.id;
  const owner = await run(["dispatch", "--source", second, "--assignment", "implement"], checkout);
  const ownerTree = z.object({ data: z.object({ worktreePath: z.string() }) }).parse(owner.output)
    .data.worktreePath;
  // The owner's account opened the PR, so the review posts with the author's own account.
  await github({ pulls: [pull({ ...assigned, author: "owner" })], viewer: "owner" });
  expect(await run(["pr", "associate"], ownerTree)).toMatchObject({ code: 0 });
  const [queued] = await next();
  expect(queued).toMatchObject({
    origin: "assignment",
    state: "queued",
    assignment: { sourceId: second, assignment: "implement" },
    action: "start_reviewer",
  });
  await draft(requestSchema.parse(queued).draft);
  expect(await run(["review", "post", url])).toMatchObject({
    output: { data: { event: "COMMENT", state: "watching", blockers: 0 } },
  });
  const [review] = await posted();
  expect(review?.body).toContain("**No blockers**");
  expect(review?.body).toContain("No blockers.");
}, 90000);

test("a retry after a lost answer records the review on GitHub, not an edited draft", async () => {
  for (const [first, edited, event, state] of [
    [
      {},
      { blockers: [{ short: "Guard has no test", detail: "Add a test." }] },
      "APPROVE",
      "approved",
    ],
    [
      { blockers: [{ short: "Guard has no test", detail: "Add a test." }] },
      {},
      "COMMENT",
      "watching",
    ],
  ] as const) {
    await setup();
    const request = await add();
    await draft(request.draft, first);
    await github({ postUncertain: true });
    expect((await run(["review", "post", url])).output.reason).toBe("github_uncertain");
    await draft(request.draft, edited);
    expect(await run(["review", "post", url])).toMatchObject({
      code: 0,
      output: { reason: "review_posted", data: { event, state, review: { event } } },
    });
    const reviews = await posted();
    expect(reviews).toHaveLength(1);
    expect(reviews[0]?.event).toBe(event);
  }
}, 90000);

test("a lost answer is recorded after the head moved, and a lost post on a moved head returns to the reviewer", async () => {
  await setup();
  const request = await add();
  await draft(request.draft);
  await github({ postUncertain: true });
  expect((await run(["review", "post", url])).output.reason).toBe("github_uncertain");
  const lostReviews = (await posted()).map((review, index) => ({
    id: `review-${index + 1}`,
    state: review.event,
    body: review.body,
    author: "owner",
  }));
  await github({ pulls: [pull({ head: "f".repeat(40), reviews: lostReviews })] });
  expect(await run(["review", "post", url])).toMatchObject({
    code: 0,
    output: { reason: "review_posted", data: { event: "APPROVE", state: "approved" } },
  });
  expect(await posted()).toHaveLength(1);

  // GitHub never received the lost post, and the head moved: no stale post, a new draft is needed.
  await setup();
  const second = await add();
  await draft(second.draft);
  await github({ postUncertain: true });
  expect((await run(["review", "post", url])).output.reason).toBe("github_uncertain");
  await github({ posted: [], pulls: [pull({ head: "f".repeat(40), reviews: [] })] });
  expect(await run(["review", "post", url])).toMatchObject({
    code: 4,
    output: { reason: "review_head_moved" },
  });
  expect(await posted()).toEqual([]);
  expect(await next()).toMatchObject([{ state: "queued", action: "start_reviewer" }]);
}, 90000);

test("a noise claim or a finding cannot hide a changed file behind another spelling", async () => {
  await setup();
  const request = await add();
  await github({
    pulls: [pull({ checks: [{ name: "ci", conclusion: "FAILURE", required: true }] })],
  });
  for (const [change, reason] of [
    [
      { noise: [{ check: "ci", files: ["./feature.ts"], reason: "Flaky." }] },
      "review_noise_changed_file",
    ],
    [
      { noise: [{ check: "ci", files: ["legacy/../feature.ts"], reason: "Flaky." }] },
      "review_draft_invalid",
    ],
    [
      { noise: [{ check: "ci", files: ["/feature.ts"], reason: "Flaky." }] },
      "review_draft_invalid",
    ],
  ] as const) {
    await draft(request.draft, change);
    expect((await run(["review", "post", url])).output, change.noise[0].files[0]).toMatchObject({
      reason,
    });
  }
  await draft(request.draft, {
    blockers: [{ short: "Broken", detail: "Broken.", path: "./feature.ts", line: 1 }],
  });
  expect(await run(["review", "post", url])).toMatchObject({ code: 0 });
  expect((await posted())[0]).toMatchObject({ comments: [{ path: "feature.ts" }] });
}, 60000);

test("a pending required check or an incomplete check list does not approve", async () => {
  await setup();
  const request = await add();
  await github({ pulls: [pull({ checks: [{ name: "ci", required: true }] })] });
  await draft(request.draft);
  expect(await run(["review", "post", url])).toMatchObject({
    code: 4,
    output: { reason: "review_ci_pending" },
  });
  await github({
    pulls: [
      pull({ checks: [{ name: "ci", conclusion: "SUCCESS", required: true }], totalChecks: 101 }),
    ],
  });
  expect(await run(["review", "post", url])).toMatchObject({
    output: { reason: "review_ci_pending" },
  });
  expect(await posted()).toEqual([]);
  // A comment can post while CI runs.
  await draft(request.draft, { blockers: [{ short: "Broken", detail: "Broken." }] });
  expect(await run(["review", "post", url])).toMatchObject({
    output: { data: { event: "COMMENT" } },
  });
  await setup();
  const done = await add();
  await github({
    pulls: [pull({ checks: [{ name: "ci", conclusion: "SUCCESS", required: true }] })],
  });
  await draft(done.draft);
  expect(await run(["review", "post", url])).toMatchObject({
    output: { data: { event: "APPROVE" } },
  });
}, 60000);

test("the reviewer fetches from the remote that has the GitHub identity, whatever its name", async () => {
  await setup();
  await git(checkout, "remote", "rename", "origin", "upstream");
  await git(checkout, "remote", "add", "origin", `${root}/fork.git`);
  await add();
  const started = await run(["review", "start", url]);
  expect(started.code, started.stderr).toBe(0);
  const worktree = z
    .object({ data: z.object({ launch: z.object({ worktreePath: z.string() }) }) })
    .parse(started.output).data.launch.worktreePath;
  expect(await git(worktree, "rev-parse", "HEAD")).toBe(head);
}, 60000);

test("a start retry moves a clean recorded worktree to the new PR head", async () => {
  await setup();
  await add();
  const herdrState = `${root}/herdr-state.json`;
  const current: object = z.looseObject({}).parse(await Bun.file(herdrState).json());
  await Bun.write(
    herdrState,
    JSON.stringify({ ...current, fail: { "agent start": "host refused" } }),
  );
  expect((await run(["review", "start", url])).output.reason).toBe("launch_failed");
  const [failed] = await next();
  const worktree = requestSchema.parse(failed).reviewer?.worktreePath ?? "";
  expect(await git(worktree, "rev-parse", "HEAD")).toBe(head);
  // The PR moves to a new commit before the retry.
  await Bun.write(`${worktree}/feature.ts`, "export const value = 2;\n");
  await git(worktree, "commit", "-q", "-am", "second");
  const moved = await git(worktree, "rev-parse", "HEAD");
  await git(worktree, "push", "-q", `${root}/remote.git`, "HEAD:refs/pull/7/head");
  await git(worktree, "reset", "-q", "--hard", head);
  head = moved;
  await github({ pulls: [pull()] });
  await Bun.write(herdrState, JSON.stringify({ ...current, fail: {} }));
  expect((await run(["review", "start", url])).code).toBe(0);
  expect(await git(worktree, "rev-parse", "HEAD")).toBe(moved);
  // A changed reviewer worktree is not reset.
  await setup();
  await add();
  const herdrAgain = `${root}/herdr-state.json`;
  const state: object = z.looseObject({}).parse(await Bun.file(herdrAgain).json());
  await Bun.write(
    herdrAgain,
    JSON.stringify({ ...state, fail: { "agent start": "host refused" } }),
  );
  await run(["review", "start", url]);
  const [kept] = await next();
  const dirty = requestSchema.parse(kept).reviewer?.worktreePath ?? "";
  await Bun.write(`${dirty}/notes.md`, "mine\n");
  const other = await git(dirty, "commit-tree", "-p", head, "-m", "moved", `${head}^{tree}`);
  await git(dirty, "push", "-q", `${root}/remote.git`, `${other}:refs/pull/7/head`);
  head = other;
  await github({ pulls: [pull()] });
  await Bun.write(herdrAgain, JSON.stringify({ ...state, fail: {} }));
  expect(await run(["review", "start", url])).toMatchObject({
    code: 1,
    output: { reason: "launch_failed" },
  });
  expect((await next())[0]).toMatchObject({
    reviewer: { failure: { reason: "review_worktree_changed" } },
  });
  expect(await Bun.file(`${dirty}/notes.md`).text()).toBe("mine\n");
}, 90000);
