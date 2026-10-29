import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
// Bun has no permission or recursive removal API.
import { chmod, rm } from "node:fs/promises";
import { z } from "zod";
import { fakeGithubScript } from "./github-fixture.ts";
import { workerDevice } from "./worker-fixture.ts";

type Device = Awaited<ReturnType<typeof workerDevice>>;
let device: Device | undefined;

afterEach(async () => {
  if (device !== undefined) await rm(device.root, { recursive: true, force: true });
  device = undefined;
});

const plan = {
  trackerKey: "github:example/one#20",
  assignments: [
    {
      key: "parent",
      trackerKey: "github:example/one#21",
      instructions: "Build the base.",
      completion: "pr",
      resources: "worktree",
      branch: "task/21-parent",
      dependencies: [],
    },
    {
      key: "child",
      trackerKey: "github:example/one#22",
      instructions: "Build on the base.",
      completion: "pr",
      resources: "worktree",
      branch: "task/22-child",
      dependencies: ["parent"],
    },
  ],
};

async function git(cwd: string, ...args: string[]) {
  const result = await (device as Device).exec(["git", ...args], cwd);
  expect(result.code, result.stderr).toBe(0);
  return result.stdout.trim();
}

async function gitFails(cwd: string, ...args: string[]) {
  return (await (device as Device).exec(["git", ...args], cwd)).code !== 0;
}

type Pull = Record<string, unknown> & { number: number };
async function github(change: (state: { pulls: Pull[] } & Record<string, unknown>) => void) {
  const file = Bun.file(`${(device as Device).root}/github.json`);
  const state = z
    .looseObject({ pulls: z.array(z.looseObject({ number: z.number() })) })
    .parse(await file.json());
  change(state);
  await Bun.write(file, JSON.stringify(state));
}

async function pull(number: number) {
  const state = z
    .object({ pulls: z.array(z.looseObject({ number: z.number() })) })
    .parse(await Bun.file(`${(device as Device).root}/github.json`).json());
  return state.pulls.find((row) => row.number === number);
}

async function baseChanges() {
  const file = Bun.file(`${(device as Device).root}/gh-calls.jsonl`);
  if (!(await file.exists())) return 0;
  return (await file.text()).split("\n").filter((line) => line.includes('"PATCH"')).length;
}

function data(output: Record<string, unknown>) {
  return z.looseObject({ reason: z.string(), data: z.looseObject({}).optional() }).parse(output);
}

/** A device whose `origin` is a real bare remote. The `github` remote names the identity. */
async function stackedDevice() {
  device = await workerDevice();
  const { root, main } = device;
  const remote = `${root}/remote.git`;
  await git(root, "init", "-q", "--bare", "-b", "main", remote);
  await git(main, "remote", "set-url", "origin", remote);
  await git(main, "remote", "add", "github", "https://github.com/example/one.git");
  await git(main, "push", "-q", "-u", "origin", "main");
  await Bun.write(`${root}/tools/gh`, fakeGithubScript(root));
  await chmod(`${root}/tools/gh`, 0o755);
  await Bun.write(`${root}/github.json`, JSON.stringify({ remote, pulls: [] }));
  const source = await device.register(plan);
  return { device, remote, source };
}

/** The parent owner commits, pushes with an upstream, opens PR #6, and associates it. */
async function openParent(source: string) {
  const owner = await (device as Device).dispatch(source, "parent");
  const worktree = owner.worktreePath ?? "";
  await Bun.write(`${worktree}/shared.txt`, "base\n");
  await git(worktree, "add", ".");
  await git(worktree, "commit", "-q", "-m", "parent");
  await git(worktree, "push", "-q", "-u", "origin", "task/21-parent");
  await github((state) => {
    state.pulls.push({
      number: 6,
      url: "https://github.com/example/one/pull/6",
      headRefName: "task/21-parent",
      headRepository: "example/one",
      state: "OPEN",
    });
  });
  const associated = await (device as Device).run(["pr", "associate"], { cwd: worktree });
  expect(associated.code, associated.stderr).toBe(0);
  return { worktree, head: await git(worktree, "rev-parse", "HEAD") };
}

/** The child owner commits its change, pushes, opens PR #8 on the parent branch, and associates. */
async function openChild(source: string, content = "child\n") {
  const owner = await (device as Device).dispatch(source, "child");
  const worktree = owner.worktreePath ?? "";
  await Bun.write(`${worktree}/child.txt`, "child\n");
  await Bun.write(`${worktree}/shared.txt`, content);
  await git(worktree, "add", ".");
  await git(worktree, "commit", "-q", "-m", "child");
  await git(worktree, "push", "-q", "-u", "origin", "task/22-child");
  await github((state) => {
    state.pulls.push({
      number: 8,
      url: "https://github.com/example/one/pull/8",
      headRefName: "task/22-child",
      headRepository: "example/one",
      baseRefName: "task/21-parent",
      state: "OPEN",
      reviewDecision: "APPROVED",
      checks: [{ name: "ci", conclusion: "SUCCESS" }],
    });
  });
  const associated = await (device as Device).run(["pr", "associate"], { cwd: worktree });
  expect(associated.code, associated.stderr).toBe(0);
  return { worktree, brief: owner.brief };
}

/** GitHub squash-merges the parent into main, deletes its branch, and main moves on. */
async function mergeParent(
  remote: string,
  parentHead: string,
  later = { file: "later.txt", text: "later\n" },
) {
  const clone = `${(device as Device).root}/merger`;
  await git((device as Device).root, "clone", "-q", remote, clone);
  await git(clone, "merge", "-q", "--squash", "origin/task/21-parent");
  await git(clone, "commit", "-q", "-m", "parent (#6)");
  await Bun.write(`${clone}/${later.file}`, later.text);
  await git(clone, "add", ".");
  await git(clone, "commit", "-q", "-m", "later");
  await git(clone, "push", "-q", "origin", "main", ":task/21-parent");
  await github((state) => {
    const parent = state.pulls.find((row) => row.number === 6);
    if (parent !== undefined) Object.assign(parent, { state: "MERGED", head: parentHead });
  });
}

function wait(cwd: string) {
  return (device as Device).run(["pr", "wait", "--timeout", "0"], { cwd });
}

async function stack(assignment: string) {
  const rows = await (device as Device).next(assignment);
  return z
    .looseObject({
      action: z.string(),
      reason: z.string(),
      pullRequest: z.looseObject({ stack: z.unknown() }).optional(),
    })
    .parse(rows[0]);
}

test("a child starts on the open parent's branch and is relayed onto main after the parent merges", async () => {
  const { remote, source } = await stackedDevice();
  expect(await stack("child")).toMatchObject({ action: "wait", reason: "dependencies_pending" });
  const parent = await openParent(source);
  expect(await stack("child")).toMatchObject({
    action: "ready_assignment",
    reason: "assignment_ready",
  });
  const child = await openChild(source);
  // The child starts at the parent's pushed head, and its upstream is its own branch.
  expect(await git(child.worktree, "rev-parse", "HEAD~1")).toBe(parent.head);
  // The start used a private ref, removed it, and left the controller's FETCH_HEAD alone.
  const main = (device as Device).main;
  expect(await Bun.file(`${main}/.git/FETCH_HEAD`).exists()).toBe(false);
  expect(await git(main, "for-each-ref", "refs/operator")).toBe("");
  expect(await git(child.worktree, "config", "branch.task/22-child.merge")).toBe(
    "refs/heads/task/22-child",
  );
  expect(await Bun.file(child.brief).text()).toContain(
    "Your branch starts on `task/21-parent`, the branch of PR #6 of assignment `parent`. Target that branch as the PR base.",
  );
  expect(await stack("child")).toMatchObject({
    reason: "pr_feedback_loop",
    pullRequest: {
      stack: { parent: { assignment: "parent", number: 6 }, state: "stacked", blocker: null },
    },
  });

  // Approved with passing checks, the stacked PR is still not eligible while it targets the parent.
  const stacked = await wait(child.worktree);
  expect(data(stacked.output)).toMatchObject({
    reason: "pr_wait_timed_out",
    data: { mergeConditions: { approved: true, checksPassing: true, defaultBase: false } },
  });

  const controller = await git((device as Device).main, "rev-parse", "HEAD");
  await mergeParent(remote, parent.head);
  const relayed = await wait(child.worktree);
  expect(relayed.code, relayed.stderr).toBe(0);
  const head = await git(child.worktree, "rev-parse", "HEAD");
  expect(data(relayed.output)).toMatchObject({
    reason: "pr_events_observed",
    data: {
      events: [{ kind: "parent_relayed", parent: { number: 6 }, base: "main", head }],
    },
  });
  // The child's own commit now sits on main, which holds the squashed parent and later work.
  expect(await git(child.worktree, "rev-parse", "HEAD~1")).toBe(
    await git(remote, "rev-parse", "refs/heads/main"),
  );
  expect(await gitFails(child.worktree, "merge-base", "--is-ancestor", parent.head, "HEAD")).toBe(
    true,
  );
  expect(await git(remote, "rev-parse", "refs/heads/task/22-child")).toBe(head);
  expect(await pull(8)).toMatchObject({ baseRefName: "main" });
  expect(await baseChanges()).toBe(1);
  // Unrelated branches and worktrees stay untouched.
  expect(await git(parent.worktree, "rev-parse", "HEAD")).toBe(parent.head);
  expect(await git((device as Device).main, "rev-parse", "HEAD")).toBe(controller);
  expect(await stack("child")).toMatchObject({
    reason: "pr_feedback_loop",
    pullRequest: { stack: { state: "relayed" } },
  });

  // A repeated wait does not relay again. With the default branch as base, the PR is eligible.
  const again = await wait(child.worktree);
  expect(data(again.output)).toMatchObject({
    reason: "pr_events_observed",
    data: { events: [{ kind: "merge_eligible", head }] },
  });
  expect(await baseChanges()).toBe(1);
  expect(await git(remote, "rev-parse", "refs/heads/task/22-child")).toBe(head);
});

test("a conflict aborts the relay, keeps the branch, and needs attention until the owner resolves it", async () => {
  const { remote, source } = await stackedDevice();
  const parent = await openParent(source);
  const child = await openChild(source, "child edit\n");
  const before = await git(child.worktree, "rev-parse", "HEAD");
  await mergeParent(remote, parent.head, { file: "shared.txt", text: "main edit\n" });

  const blocked = await wait(child.worktree);
  expect(blocked.code).toBe(3);
  expect(blocked.output).toMatchObject({ reason: "relay_conflict" });
  expect(await git(child.worktree, "rev-parse", "HEAD")).toBe(before);
  expect(await git(child.worktree, "status", "--porcelain")).toBe("");
  expect(await gitFails(child.worktree, "rev-parse", "--verify", "--quiet", "REBASE_HEAD")).toBe(
    true,
  );
  expect(await git(remote, "rev-parse", "refs/heads/task/22-child")).toBe(before);
  expect(await baseChanges()).toBe(0);
  expect(await stack("child")).toMatchObject({
    action: "owner_attention",
    reason: "pr_relay_blocked",
    pullRequest: { stack: { state: "blocked", blocker: { reason: "relay_conflict" } } },
  });

  // The owner rebases with its own resolution and pushes. The relay then only changes the base.
  await git(child.worktree, "fetch", "-q", "origin", "main");
  await git(child.worktree, "rebase", "-q", "-X", "theirs", "--onto", "FETCH_HEAD", parent.head);
  await git(child.worktree, "push", "-q", "--force", "origin", "HEAD:task/22-child");
  const resolved = await git(child.worktree, "rev-parse", "HEAD");
  const relayed = await wait(child.worktree);
  expect(data(relayed.output)).toMatchObject({
    reason: "pr_events_observed",
    data: { events: [{ kind: "parent_relayed", head: resolved }] },
  });
  expect(await git(remote, "rev-parse", "refs/heads/task/22-child")).toBe(resolved);
  expect(await baseChanges()).toBe(1);
  expect(await stack("child")).toMatchObject({ reason: "pr_feedback_loop" });
});

test("a failed base change stays a blocker, and the next wait continues without a second push", async () => {
  const { remote, source } = await stackedDevice();
  const parent = await openParent(source);
  const child = await openChild(source);
  await mergeParent(remote, parent.head);
  await github((state) => {
    state.failPatch = "Validation Failed";
  });

  const failed = await wait(child.worktree);
  expect(failed.code).toBe(1);
  expect(failed.output).toMatchObject({ reason: "relay_retarget_failed" });
  const pushed = await git(child.worktree, "rev-parse", "HEAD");
  expect(await git(remote, "rev-parse", "refs/heads/task/22-child")).toBe(pushed);
  expect(await pull(8)).toMatchObject({ baseRefName: "task/21-parent" });
  expect(await stack("child")).toMatchObject({
    action: "owner_attention",
    reason: "pr_relay_blocked",
  });

  await github((state) => {
    state.failPatch = null;
  });
  const relayed = await wait(child.worktree);
  expect(data(relayed.output)).toMatchObject({
    data: { events: [{ kind: "parent_relayed", head: pushed }] },
  });
  expect(await git(remote, "rev-parse", "refs/heads/task/22-child")).toBe(pushed);
  expect(await baseChanges()).toBe(2);
});

test("a live relay claim holds other waits, a stopped one is taken over, and simultaneous waits relay once", async () => {
  const { remote, source } = await stackedDevice();
  const parent = await openParent(source);
  const child = await openChild(source);
  const before = await git(child.worktree, "rev-parse", "HEAD");
  await mergeParent(remote, parent.head);
  const database = `${(device as Device).root}/state/operator/operator.sqlite`;
  function claim(pid: number) {
    using db = new Database(database);
    db.query(
      "UPDATE pull_requests SET relay = json_set(relay, '$.ownerPid', ?, '$.leaseAt', ?) WHERE number = 8",
    ).run(pid, new Date().toISOString());
  }

  // This test process stands for another live relay of the same PR.
  claim(process.pid);
  const held = await wait(child.worktree);
  expect(data(held.output)).toMatchObject({ reason: "pr_wait_timed_out" });
  expect(await git(child.worktree, "rev-parse", "HEAD")).toBe(before);
  expect(await baseChanges()).toBe(0);

  // A relay whose process stopped frees its claim, so the next waits continue it.
  claim(Bun.spawnSync([process.execPath, "--version"]).pid);
  const results = await Promise.all([wait(child.worktree), wait(child.worktree)]);
  for (const result of results) expect(result.code, result.stderr).toBe(0);
  const events = results.flatMap((result) =>
    z
      .object({ data: z.object({ events: z.array(z.looseObject({ kind: z.string() })) }) })
      .parse(result.output)
      .data.events.map((event) => event.kind),
  );
  expect(events.filter((kind) => kind === "parent_relayed")).toHaveLength(1);
  expect(await baseChanges()).toBe(1);
  expect(await git(remote, "rev-parse", "refs/heads/task/22-child")).toBe(
    await git(child.worktree, "rev-parse", "HEAD"),
  );
});

test("a stacked PR moved to main by hand stays ineligible until its relay finishes", async () => {
  const { remote, source } = await stackedDevice();
  const parent = await openParent(source);
  const child = await openChild(source);
  await github((state) => {
    const pr = state.pulls.find((row) => row.number === 8);
    if (pr !== undefined) pr.baseRefName = "main";
  });
  // The parent is still open, so its commits would ride along into main.
  const early = await wait(child.worktree);
  expect(data(early.output)).toMatchObject({
    reason: "pr_wait_timed_out",
    data: { mergeConditions: { defaultBase: true, stackRelayed: false } },
  });
  // The guarded merge reads the same condition, so it refuses before any merge request.
  const merge = await (device as Device).run(["pr", "merge"], { cwd: child.worktree });
  expect(merge.output).toMatchObject({ reason: "pr_merge_blocked" });
  expect(JSON.stringify(merge.output)).toContain("a finished parent-merge relay");
  expect(await pull(8)).toMatchObject({ state: "OPEN" });
  await mergeParent(remote, parent.head);
  const relayed = await wait(child.worktree);
  expect(data(relayed.output)).toMatchObject({
    data: { events: [{ kind: "parent_relayed", base: "main" }] },
  });
  // The base was already main, so the relay rebased and pushed without a base change.
  expect(await baseChanges()).toBe(0);
  const eligible = await wait(child.worktree);
  expect(data(eligible.output)).toMatchObject({
    data: {
      events: [{ kind: "merge_eligible" }],
      mergeConditions: { defaultBase: true, stackRelayed: true },
    },
  });
});

test("a PR base that is neither main nor a dependency's branch is refused without a change", async () => {
  const { source } = await stackedDevice();
  await openParent(source);
  const owner = await (device as Device).dispatch(source, "child");
  const worktree = owner.worktreePath ?? "";
  await git(worktree, "push", "-q", "-u", "origin", "task/22-child");
  await github((state) => {
    state.pulls.push({
      number: 8,
      url: "https://github.com/example/one/pull/8",
      headRefName: "task/22-child",
      headRepository: "example/one",
      baseRefName: "integration",
      state: "OPEN",
    });
  });
  const refused = await (device as Device).run(["pr", "associate"], { cwd: worktree });
  expect(refused.code).toBe(4);
  expect(refused.output).toMatchObject({ reason: "pr_base_invalid" });
  expect(await stack("child")).toMatchObject({ reason: "assignment_active" });
});

test("an unaccepted report dependency blocks start, and its acceptance permits it", async () => {
  device = await workerDevice();
  const source = await device.register({
    trackerKey: "github:example/one#30",
    assignments: [
      {
        key: "research",
        trackerKey: "github:example/one#31",
        instructions: "Read and report.",
        completion: "report",
        resources: "pane",
        dependencies: [],
      },
      {
        key: "build",
        trackerKey: "github:example/one#32",
        instructions: "Build it.",
        completion: "pr",
        resources: "worktree",
        branch: "task/32-build",
        dependencies: ["research"],
      },
    ],
  });
  const worker = await device.dispatch(source, "research");
  const report = await device.writeJson("report.json", {
    conclusion: "Done.",
    evidence: ["a.ts:1"],
    unresolved: [],
  });
  expect(
    (await device.run(["report", "submit", "--file", report], { pane: worker.paneId })).code,
  ).toBe(0);
  expect(await stack("build")).toMatchObject({
    action: "wait",
    reason: "dependencies_pending",
    blockers: [{ assignment: "research", state: "reported", required: "completed" }],
  });
  const refused = await device.run(["dispatch", "--source", source, "--assignment", "build"]);
  expect(refused.output).toMatchObject({ reason: "assignment_not_dispatchable" });
  expect((await device.herdrCalls()).filter((call) => call === "worktree create")).toEqual([]);
  expect(
    (await device.run(["report", "accept", "--source", source, "--assignment", "research"])).code,
  ).toBe(0);
  expect(await stack("build")).toMatchObject({ action: "ready_assignment" });
});
