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
const branch = "task/12-implement";

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

function plan(keys: string[]) {
  return {
    trackerKey: "github:example/one#10",
    assignments: keys.map((key, index) => ({
      key,
      trackerKey: `github:example/one#${12 + index}`,
      instructions: "Implement the change.",
      completion: "pr",
      resources: "worktree",
      branch: index === 0 ? branch : `task/${12 + index}-${key}`,
      dependencies: [],
    })),
  };
}

/** The fixture has a tracked Bun lockfile with a local dependency, so preparation installs. */
async function setup(
  host: "opencode" | "claude-code",
  keys = ["implement", "second"],
  ignoreDependencies = "node_modules",
) {
  root = await realpath(await mkdtemp(path.join(tmpdir(), "operator-merge-")));
  checkout = `${root}/checkout`;
  await mkdir(checkout);
  await git(checkout, "init", "-q", "-b", "main");
  await git(checkout, "remote", "add", "origin", "https://github.com/example/one.git");
  await Bun.write(`${checkout}/README.md`, "fixture\n");
  await Bun.write(`${checkout}/.gitignore`, `.env*\n${ignoreDependencies}\n`);
  await Bun.write(
    `${checkout}/dep/package.json`,
    JSON.stringify({ name: "dep", version: "1.0.0" }),
  );
  await Bun.write(`${checkout}/dep/index.js`, "export const value = 1;\n");
  await Bun.write(
    `${checkout}/package.json`,
    JSON.stringify({ name: "fixture", private: true, dependencies: { dep: "file:./dep" } }),
  );
  expect((await exec([process.execPath, "install"])).code).toBe(0);
  await rm(`${checkout}/node_modules`, { recursive: true, force: true });
  await git(checkout, "add", ".");
  await git(checkout, "commit", "-q", "-m", "fixture");
  await Bun.write(`${checkout}/.env.local`, "TOKEN=local\n");
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
  const installed = await run(["herdr", "install"]);
  expect(installed.code, JSON.stringify(installed.output)).toBe(0);
  await Bun.write(`${root}/plan.json`, JSON.stringify(plan(keys)));
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
    .object({ data: z.object({ worktreePath: z.string(), paneId: z.string() }) })
    .parse(launched.output).data;
}

async function readJson(file: string) {
  const handle = Bun.file(file);
  return (await handle.exists()) ? z.looseObject({}).parse(await handle.json()) : {};
}

async function github(change: Record<string, unknown>) {
  const current = await readJson(`${root}/github.json`);
  await Bun.write(`${root}/github.json`, JSON.stringify({ ...current, ...change }));
}

async function setHerdr(change: Record<string, unknown>) {
  const current = await readJson(`${root}/herdr-state.json`);
  await Bun.write(`${root}/herdr-state.json`, JSON.stringify({ ...current, ...change }));
}

async function calls(file: string, text: string) {
  const handle = Bun.file(`${root}/${file}`);
  if (!(await handle.exists())) return 0;
  return (await handle.text())
    .trim()
    .split("\n")
    .filter((line) => line.includes(text)).length;
}

const eligible = {
  reviewDecision: "APPROVED",
  reviews: [{ id: "R1", state: "APPROVED", body: "" }],
  checks: [{ name: "lint", conclusion: "SUCCESS" }],
};

/** The owner commits its change, opens the PR at that head, and associates it. */
async function openPullRequest(source: string, change: Record<string, unknown> = eligible) {
  const worker = await dispatch(source);
  await Bun.write(`${worker.worktreePath}/feature.txt`, "feature\n");
  await git(worker.worktreePath, "add", "feature.txt");
  await git(worker.worktreePath, "commit", "-q", "-m", "feature");
  const head = await git(worker.worktreePath, "rev-parse", "HEAD");
  await github({
    pulls: [
      {
        number: 7,
        url: "https://github.com/example/one/pull/7",
        headRefName: branch,
        headRepository: "example/one",
        state: "OPEN",
        head,
        ...change,
      },
    ],
    branches: { [branch]: head },
  });
  expect((await run(["pr", "associate"], worker.worktreePath)).code).toBe(0);
  return { ...worker, head };
}

const cleanupSchema = z.looseObject({
  step: z.string().nullable(),
  state: z.string(),
  reason: z.string().nullable(),
  detail: z.string().nullable(),
  running: z.boolean(),
});

async function shown(source: string) {
  const result = await run(["source", "show", "--source", source]);
  return z
    .object({
      data: z.looseObject({
        state: z.string(),
        assignments: z.array(z.looseObject({ key: z.string(), state: z.string() })),
        cleanups: z.array(cleanupSchema),
        pullRequests: z.array(z.looseObject({})),
        launches: z.array(z.looseObject({ state: z.string() })),
      }),
    })
    .parse(result.output).data;
}

/** The merge starts cleanup in its own process. Each test waits until that process stops. */
async function settled(source: string) {
  const deadline = Date.now() + 30000;
  for (;;) {
    const cleanup = (await shown(source)).cleanups[0];
    if (cleanup !== undefined && !cleanup.running && cleanup.state !== "pending") return cleanup;
    expect(Date.now()).toBeLessThan(deadline);
    await Bun.sleep(100);
  }
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

/** Waits until the fake gh writes its hold marker. */
async function held(marker: string) {
  const deadline = Date.now() + 30000;
  while (!(await Bun.file(`${root}/${marker}`).exists())) {
    expect(Date.now()).toBeLessThan(deadline);
    await Bun.sleep(20);
  }
}

async function exists(file: string) {
  return (await realpath(file).catch(() => null)) !== null;
}

for (const host of ["opencode", "claude-code"] as const)
  test(`${host}: a verified merge deletes the remote branch, closes the pane, and removes the prepared worktree`, async () => {
    const source = await setup(host);
    const worker = await openPullRequest(source);
    // Preparation installed dependencies from the lockfile and copied the local environment file.
    expect(await exists(`${worker.worktreePath}/node_modules/dep/index.js`)).toBe(true);
    expect(await Bun.file(`${worker.worktreePath}/.env.local`).text()).toBe("TOKEN=local\n");

    const merged = await run(["pr", "merge"], worker.worktreePath);
    expect(merged).toMatchObject({
      code: 0,
      output: {
        reason: "pr_merged",
        data: {
          assignment: "implement",
          number: 7,
          head: worker.head,
          mergeCommit: `merge-${worker.head}`,
          state: "merged",
          cleanup: "started",
        },
      },
    });
    expect(await settled(source)).toMatchObject({ step: null, state: "done", reason: null });
    expect(await calls("gh-calls.jsonl", '"PUT"')).toBe(1);
    expect(await calls("gh-calls.jsonl", `"merge_method=squash"`)).toBe(1);
    expect(await readJson(`${root}/github.json`)).toMatchObject({ branches: {} });
    expect(await calls("herdr-calls.jsonl", '"pane","close"')).toBe(1);
    expect(await exists(worker.worktreePath)).toBe(false);
    expect(await git(checkout, "branch", "--list", branch)).toBe("");
    expect(await git(checkout, "worktree", "list", "--porcelain")).not.toContain(
      worker.worktreePath,
    );
    // The controlling checkout keeps its own ignored files.
    expect(await Bun.file(`${checkout}/.env.local`).text()).toBe("TOKEN=local\n");

    const state = await shown(source);
    expect(state).toMatchObject({
      state: "open",
      assignments: [
        { key: "implement", state: "merged" },
        { key: "second", state: "ready" },
      ],
      pullRequests: [{ number: 7, mergedHead: worker.head, mergeCommit: `merge-${worker.head}` }],
      launches: [{ state: "interrupted" }],
    });
    // A finished cleanup leaves no action, and the other assignment still progresses.
    expect(await entry(source)).toBeUndefined();
    expect(await entry(source, "second")).toMatchObject({ action: "ready_assignment" });
    expect(await run(["cleanup", "--source", source, "--assignment", "implement"])).toMatchObject({
      code: 0,
      output: { reason: "cleanup_unchanged" },
    });
  }, 90000);

test("every merge refusal leaves GitHub and device state unchanged", async () => {
  const source = await setup("opencode");
  const worker = await openPullRequest(source, {});
  // An earlier wait reported eligibility. The merge still observes GitHub again.
  await github({ queue: [eligible] });
  expect(await run(["pr", "wait", "--timeout", "0"], worker.worktreePath)).toMatchObject({
    output: { data: { events: [{ kind: "feedback" }, { kind: "merge_eligible" }] } },
  });
  const pull = { number: 7, headRefName: branch, headRepository: "example/one", state: "OPEN" };
  const refusals: [object, string][] = [
    [{ ...eligible, reviewDecision: "REVIEW_REQUIRED" }, "pr_merge_blocked"],
    [{ ...eligible, checks: [] }, "pr_merge_blocked"],
    [{ ...eligible, checks: [{ name: "lint" }] }, "pr_merge_blocked"],
    [{ ...eligible, checks: [{ name: "lint", conclusion: "FAILURE" }] }, "pr_merge_blocked"],
    [{ ...eligible, threads: [{ comments: [{ id: "T1", body: "Fix." }] }] }, "pr_merge_blocked"],
    [{ ...eligible, baseRefName: "release" }, "pr_merge_blocked"],
    [{ ...eligible, head: "pushed-elsewhere" }, "pr_head_mismatch"],
    [{ ...eligible, state: "CLOSED" }, "pr_not_open"],
  ];
  const before = await Bun.file(database()).arrayBuffer();
  for (const [change, reason] of refusals) {
    await github({ pulls: [{ ...pull, head: worker.head, ...change }], queue: [] });
    expect(await run(["pr", "merge"], worker.worktreePath)).toMatchObject({
      code: 3,
      output: { reason },
    });
  }
  expect(await calls("gh-calls.jsonl", '"PUT"')).toBe(0);
  expect(await Bun.file(database()).arrayBuffer()).toEqual(before);

  // A worktree outside the owner, and a GitHub refusal, merge nothing either.
  await github({ pulls: [{ ...pull, head: worker.head, ...eligible }] });
  expect(await run(["pr", "merge"], checkout)).toMatchObject({
    code: 4,
    output: { reason: "pr_worktree_unrecorded" },
  });
  expect(await run(["pr", "merge", "--assignment", "second"], worker.worktreePath)).toMatchObject({
    code: 2,
  });
  await github({ mergeRefuse: true });
  expect(await run(["pr", "merge"], worker.worktreePath)).toMatchObject({
    code: 1,
    output: { reason: "pr_merge_refused" },
  });
  expect(await Bun.file(database()).arrayBuffer()).toEqual(before);
  expect(await entry(source)).toMatchObject({ action: "wait", reason: "pr_feedback_loop" });
  expect(await exists(worker.worktreePath)).toBe(true);
}, 90000);

test("a lost merge answer and a concurrent merge are verified and recorded once", async () => {
  const source = await setup("opencode");
  const worker = await openPullRequest(source);
  // The merge's cleanup removes the worktree that both commands run in. The cleanup waits at its
  // remote branch step until both commands answer, so the second command never starts or runs
  // in a removed folder.
  await github({ mergeLost: true, cleanupHold: true });
  const both = await Promise.all([
    run(["pr", "merge"], worker.worktreePath),
    run(["pr", "merge"], worker.worktreePath),
  ]);
  const reasons = both.map(
    (result) => z.object({ reason: z.string() }).parse(result.output).reason,
  );
  expect(reasons.filter((reason) => reason === "pr_merged")).toHaveLength(1);
  for (const reason of reasons)
    expect(reason).toBeOneOf(["pr_merged", "pr_merge_unchanged", "pr_owner_inactive"]);
  await held("cleanup-held");
  expect(await exists(worker.worktreePath)).toBe(true);
  await Bun.write(`${root}/cleanup-release`, "");
  expect(await settled(source)).toMatchObject({ state: "done" });
  const state = await shown(source);
  expect(state.cleanups).toHaveLength(1);
  expect(state.assignments[0]).toMatchObject({ state: "merged" });
}, 90000);

test("a PR that the person merged on GitHub is verified without another merge request", async () => {
  const second = await setup("opencode", ["implement"]);
  const owner = await openPullRequest(second, { reviewDecision: "REVIEW_REQUIRED" });
  await github({ queue: [{ state: "MERGED", mergeCommit: "person-merge" }] });
  expect(await run(["pr", "merge"], owner.worktreePath)).toMatchObject({
    code: 0,
    output: { reason: "pr_merged", data: { mergeCommit: "person-merge" } },
  });
  expect(await calls("gh-calls.jsonl", '"PUT"')).toBe(0);
  expect(await settled(second)).toMatchObject({ state: "done" });
  // The last merge finished the source, and its finished cleanup leaves only the ended source.
  expect((await shown(second)).state).toBe("finished");
  const next = await run(["next", "--source", second]);
  expect(next.output).toMatchObject({
    data: { sources: [{ state: "finished", actions: [{ action: "source_ended" }], waits: [] }] },
  });
}, 90000);

test("failed steps stop the declared order, stay visible, and continue after a restart", async () => {
  const source = await setup("opencode", ["implement"]);
  const worker = await openPullRequest(source);
  await github({ deleteLost: true });
  expect((await run(["pr", "merge"], worker.worktreePath)).code).toBe(0);
  expect(await settled(source)).toMatchObject({
    step: "remote_branch",
    state: "failed",
    reason: "cleanup_failed",
  });
  // The pane and worktree wait for the remote branch, even in a finished source.
  expect(await calls("herdr-calls.jsonl", '"pane","close"')).toBe(0);
  expect(await exists(worker.worktreePath)).toBe(true);
  expect((await shown(source)).state).toBe("finished");
  const next = await run(["next", "--source", source]);
  expect(next.output).toMatchObject({
    data: {
      sources: [
        {
          state: "finished",
          actions: [
            { action: "source_ended" },
            {
              assignment: "implement",
              action: "retry_cleanup",
              reason: "cleanup_failed",
              cleanup: { step: "remote_branch", state: "failed" },
            },
          ],
        },
      ],
    },
  });
  // An open cleanup keeps the project registration, so the obligation cannot be hidden.
  expect(await run(["project", "remove", "example/one", "--person-instructed"])).toMatchObject({
    code: 3,
    output: { reason: "project_cleanup_open" },
  });

  await github({ deleteLost: false });
  await setHerdr({ fail: { "pane close": "herdr refused" } });
  expect(await run(["cleanup", "--source", source, "--assignment", "implement"])).toMatchObject({
    code: 1,
    output: { reason: "cleanup_failed" },
  });
  expect(await settled(source)).toMatchObject({ step: "pane", state: "failed" });
  expect(await readJson(`${root}/github.json`)).toMatchObject({ branches: {} });
  expect(await exists(worker.worktreePath)).toBe(true);

  // A new process continues at the recorded step and does not repeat the finished one.
  await setHerdr({ fail: {} });
  const deletions = await calls("gh-calls.jsonl", '"DELETE"');
  expect(await run(["cleanup", "--source", source, "--assignment", "implement"])).toMatchObject({
    code: 0,
    output: {
      reason: "cleanup_finished",
      data: {
        steps: [
          { step: "pane", outcome: "closed" },
          { step: "worktree", outcome: "removed" },
        ],
      },
    },
  });
  expect(await calls("gh-calls.jsonl", '"DELETE"')).toBe(deletions);
  expect(await exists(worker.worktreePath)).toBe(false);
  expect((await run(["next", "--source", source])).output).toMatchObject({
    data: { sources: [{ actions: [{ action: "source_ended" }] }] },
  });
}, 120000);

test("unlanded work and unknown ignored content stay until the person instructs deletion", async () => {
  const source = await setup("opencode");
  const worker = await openPullRequest(source);
  await Bun.write(`${worker.worktreePath}/notes.txt`, "unlanded\n");
  await Bun.write(`${worker.worktreePath}/.env.backup`, "ignored but unknown\n");
  await Bun.write(`${worker.worktreePath}/.env.local`, "TOKEN=changed\n");
  expect((await run(["pr", "merge"], worker.worktreePath)).code).toBe(0);
  const blocked = await settled(source);
  expect(blocked).toMatchObject({
    step: "worktree",
    state: "blocked",
    reason: "cleanup_unlanded_work",
  });
  expect(blocked.detail).toContain("notes.txt");
  expect(blocked.detail).toContain(".env.backup");
  expect(blocked.detail).toContain(".env.local");
  expect(blocked.detail).not.toContain("node_modules");
  expect(await entry(source)).toMatchObject({
    action: "person_decision",
    reason: "cleanup_unlanded_work",
  });
  expect(await readJson(`${root}/github.json`)).toMatchObject({ branches: {} });
  expect(await calls("herdr-calls.jsonl", '"pane","close"')).toBe(1);

  // Each retry inspects again. Removing the files is not enough while a commit has not landed.
  await rm(`${worker.worktreePath}/notes.txt`);
  await rm(`${worker.worktreePath}/.env.backup`);
  await Bun.write(`${worker.worktreePath}/.env.local`, "TOKEN=local\n");
  await Bun.write(`${worker.worktreePath}/later.txt`, "later\n");
  await git(worker.worktreePath, "add", "later.txt");
  await git(worker.worktreePath, "commit", "-q", "-m", "after merge");
  const retried = await run(["cleanup", "--source", source, "--assignment", "implement"]);
  expect(retried).toMatchObject({ code: 3, output: { reason: "cleanup_unlanded_work" } });
  expect(JSON.stringify(retried.output)).toContain("commits that are not in the merged head");
  expect(await exists(`${worker.worktreePath}/later.txt`)).toBe(true);
  expect(await entry(source, "second")).toMatchObject({ action: "ready_assignment" });

  expect(
    await run(["cleanup", "--source", source, "--assignment", "implement", "--person-instructed"]),
  ).toMatchObject({
    code: 0,
    output: { reason: "cleanup_finished", data: { steps: [{ step: "worktree" }] } },
  });
  expect(await exists(worker.worktreePath)).toBe(false);
  expect(await entry(source)).toBeUndefined();
}, 120000);

test("a moved remote branch and a foreign checkout at the worktree path are never deleted", async () => {
  const source = await setup("opencode");
  const worker = await openPullRequest(source);
  await github({ branches: { [branch]: "pushed-after-merge" } });
  await setHerdr({ fail: { "pane close": "herdr refused" } });
  expect((await run(["pr", "merge"], worker.worktreePath)).code).toBe(0);
  expect(await settled(source)).toMatchObject({
    step: "remote_branch",
    state: "blocked",
    reason: "cleanup_unlanded_work",
  });
  expect(await readJson(`${root}/github.json`)).toMatchObject({
    branches: { [branch]: "pushed-after-merge" },
  });
  expect(await calls("gh-calls.jsonl", '"DELETE"')).toBe(0);

  await github({ branches: { [branch]: worker.head } });
  expect(await run(["cleanup", "--source", source, "--assignment", "implement"])).toMatchObject({
    code: 1,
    output: { reason: "cleanup_failed" },
  });
  // Another repository now sits at the recorded path. It is not the recorded worktree.
  await rm(worker.worktreePath, { recursive: true, force: true });
  await mkdir(worker.worktreePath);
  await git(worker.worktreePath, "init", "-q", "-b", branch);
  await Bun.write(`${worker.worktreePath}/keep.txt`, "keep\n");
  await setHerdr({ fail: {} });
  expect(await run(["cleanup", "--source", source, "--assignment", "implement"])).toMatchObject({
    code: 3,
    output: { reason: "cleanup_resource_mismatch" },
  });
  expect(await Bun.file(`${worker.worktreePath}/keep.txt`).text()).toBe("keep\n");
  expect(await entry(source)).toMatchObject({
    action: "person_decision",
    reason: "cleanup_resource_mismatch",
  });
  // Even the person's instruction never removes a foreign checkout.
  expect(
    await run(["cleanup", "--source", source, "--assignment", "implement", "--person-instructed"]),
  ).toMatchObject({ code: 3, output: { reason: "cleanup_resource_mismatch" } });
  expect(await Bun.file(`${worker.worktreePath}/keep.txt`).text()).toBe("keep\n");
  // When the person moves it away, the gone worktree is observed and the cleanup finishes.
  await rm(worker.worktreePath, { recursive: true, force: true });
  expect(await run(["cleanup", "--source", source, "--assignment", "implement"])).toMatchObject({
    code: 0,
    output: { data: { steps: [{ step: "worktree", outcome: "absent" }] } },
  });
  // The gone folder leaves no Git registration, and its landed local branch is deleted.
  expect(await git(checkout, "worktree", "list", "--porcelain")).not.toContain(worker.worktreePath);
  expect(await git(checkout, "branch", "--list", branch)).toBe("");
}, 120000);

test("a worktree whose workspace stays open is removed through Herdr", async () => {
  const source = await setup("opencode");
  const worker = await openPullRequest(source);
  const workspace = z
    .object({
      workspaces: z.array(
        z.object({
          workspace_id: z.string(),
          worktree: z.looseObject({ checkout_path: z.string() }),
        }),
      ),
    })
    .parse(await readJson(`${root}/herdr-state.json`))
    .workspaces.find((row) => row.worktree.checkout_path === worker.worktreePath);
  expect(workspace).toBeDefined();
  await exec([
    "herdr",
    "tab",
    "create",
    "--workspace",
    workspace?.workspace_id ?? "",
    "--label",
    "extra",
  ]);
  expect((await run(["pr", "merge"], worker.worktreePath)).code).toBe(0);
  expect(await settled(source)).toMatchObject({ state: "done" });
  expect(await calls("herdr-calls.jsonl", '"worktree","remove"')).toBe(1);
  expect(await exists(worker.worktreePath)).toBe(false);
}, 90000);

test("the person's instruction covers only the blocked step that the person read", async () => {
  const source = await setup("opencode");
  const worker = await openPullRequest(source);
  await Bun.write(`${worker.worktreePath}/notes.txt`, "unlanded\n");
  await github({ branches: { [branch]: "pushed-after-merge" } });
  expect((await run(["pr", "merge"], worker.worktreePath)).code).toBe(0);
  const blocked = await settled(source);
  expect(blocked).toMatchObject({ step: "remote_branch", state: "blocked" });
  expect(blocked.detail).not.toContain("notes.txt");
  // The person authorizes deleting the moved remote branch, not the worktree it never saw.
  const instructed = await run([
    "cleanup",
    "--source",
    source,
    "--assignment",
    "implement",
    "--person-instructed",
  ]);
  expect(instructed).toMatchObject({ code: 3, output: { reason: "cleanup_unlanded_work" } });
  expect(JSON.stringify(instructed.output)).toContain("notes.txt");
  expect(await readJson(`${root}/github.json`)).toMatchObject({ branches: {} });
  expect(await calls("herdr-calls.jsonl", '"pane","close"')).toBe(1);
  expect(await Bun.file(`${worker.worktreePath}/notes.txt`).text()).toBe("unlanded\n");
  expect(await settled(source)).toMatchObject({ step: "worktree", state: "blocked" });
}, 90000);

test("a node_modules/* ignore pattern still marks dependency folders as preparation output", async () => {
  const source = await setup("opencode", ["implement"], "node_modules/*");
  const worker = await openPullRequest(source);
  expect(await exists(`${worker.worktreePath}/node_modules/dep/index.js`)).toBe(true);
  const merged = await run(["pr", "merge"], worker.worktreePath);
  expect(merged).toMatchObject({ code: 0, output: { reason: "pr_merged" } });
  // The merge records its cleanup process at once, so next never asks for a retry meanwhile.
  expect((await entry(source))?.action).not.toBe("retry_cleanup");
  expect(await settled(source)).toMatchObject({ state: "done" });
  expect(await exists(worker.worktreePath)).toBe(false);
}, 90000);
