import { afterEach, beforeEach, expect, test } from "bun:test";
// Bun has no temporary-directory, realpath, or recursive removal API.
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Environment } from "../environment/main.ts";
import { decideRelay, needsParent, relayBranch, relaySchema, stacked } from "./relay.ts";

const parent = { assignment: "parent", number: 6, branch: "task/parent" };
const open = { state: "OPEN" as const, defaultBranch: "main" };

test("only an unfinished relay of an open child reads its parent", () => {
  const relay = stacked(parent);
  expect(relaySchema.parse(relay)).toEqual(relay);
  expect(needsParent(relay, open)).toBe(true);
  expect(needsParent({ ...relay, state: "blocked" }, open)).toBe(true);
  expect(needsParent({ ...relay, state: "relayed" }, open)).toBe(false);
  expect(needsParent(relay, { ...open, state: "MERGED" })).toBe(false);
  expect(needsParent(null, open)).toBe(false);
});

test("the parent's state decides the relay", () => {
  const relay = stacked(parent);
  const merged = { state: "MERGED" as const, base: "main", head: "p1" };
  expect(decideRelay(relay, open, { ...merged, state: "OPEN" })).toEqual({ action: "none" });
  expect(decideRelay(relay, open, merged)).toEqual({ action: "relay", defaultBranch: "main" });
  expect(decideRelay(relay, open, { ...merged, state: "CLOSED" })).toMatchObject({
    action: "blocked",
    blocker: { reason: "relay_parent_closed" },
  });
  expect(decideRelay(relay, open, { ...merged, base: "task/grandparent" })).toMatchObject({
    action: "blocked",
    blocker: { reason: "relay_parent_base" },
  });
  expect(decideRelay(relay, { ...open, defaultBranch: null }, merged)).toMatchObject({
    action: "blocked",
    blocker: { reason: "relay_parent_base" },
  });
});

let root = "";
let remote = "";
let work = "";
const env = Environment.child({ GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" });

function git(cwd: string, ...args: string[]) {
  const result = Bun.spawnSync(["git", ...args], { cwd, env, stderr: "pipe" });
  expect(result.exitCode, result.stderr.toString()).toBe(0);
  return result.stdout.toString().trim();
}

async function commit(cwd: string, file: string, text: string) {
  await Bun.write(`${cwd}/${file}`, text);
  git(cwd, "add", ".");
  git(cwd, "commit", "-q", "-m", file);
  return git(cwd, "rev-parse", "HEAD");
}

// A pushed parent and child, with the parent squash-merged into main by another clone.
let parentHead = "";
let childHead = "";
beforeEach(async () => {
  root = await realpath(await mkdtemp(path.join(tmpdir(), "operator-relay-")));
  remote = `${root}/remote.git`;
  work = `${root}/work`;
  git(root, "init", "-q", "--bare", "-b", "main", remote);
  git(root, "init", "-q", "-b", "main", work);
  for (const [key, value] of [
    ["user.name", "Fixture"],
    ["user.email", "fixture@example.com"],
    ["commit.gpgsign", "false"],
  ] as const)
    git(work, "config", key, value);
  git(work, "remote", "add", "origin", remote);
  await commit(work, "README.md", "fixture\n");
  git(work, "push", "-q", "-u", "origin", "main");
  git(work, "switch", "-q", "-c", "task/parent");
  parentHead = await commit(work, "parent.txt", "parent\n");
  git(work, "push", "-q", "-u", "origin", "task/parent");
  git(work, "switch", "-q", "-c", "task/child");
  childHead = await commit(work, "child.txt", "child\n");
  git(work, "push", "-q", "-u", "origin", "task/child");
  git(work, "switch", "-q", "main");
  git(work, "merge", "-q", "--squash", "task/parent");
  git(work, "commit", "-q", "-m", "parent (#6)");
  git(work, "push", "-q", "origin", "main");
  git(work, "reset", "-q", "--hard", "HEAD~1");
  git(work, "switch", "-q", "task/child");
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function input(change: Partial<Parameters<typeof relayBranch>[0]> = {}) {
  const calls = { recorded: [] as string[], retargeted: 0 };
  return {
    calls,
    value: {
      worktree: work,
      branch: "task/child",
      head: childHead,
      base: "task/parent",
      defaultBranch: "main",
      parentHead,
      rebasedHead: null,
      recordRebase: async (head: string) => {
        calls.recorded.push(head);
        return true;
      },
      retarget: async () => {
        calls.retargeted++;
        return null;
      },
      ...change,
    },
  };
}

test("a relay rebases only the child's commits, records the head, pushes, and changes the base", async () => {
  const { calls, value } = input();
  const result = await relayBranch(value);
  const head = git(work, "rev-parse", "HEAD");
  expect(result).toEqual({ head });
  expect(calls).toEqual({ recorded: [head], retargeted: 1 });
  expect(git(work, "rev-parse", "HEAD~1")).toBe(git(remote, "rev-parse", "refs/heads/main"));
  expect(git(remote, "rev-parse", "refs/heads/task/child")).toBe(head);
  expect(git(remote, "rev-parse", "refs/heads/task/parent")).toBe(parentHead);

  // A repeated relay finds every step done and repeats no branch operation.
  const repeated = input({ head, base: "main", rebasedHead: head });
  expect(await relayBranch(repeated.value)).toEqual({ head });
  expect(repeated.calls).toEqual({ recorded: [], retargeted: 0 });
});

test("uncommitted or unpushed work stops the relay before any branch change", async () => {
  await Bun.write(`${work}/child.txt`, "changed\n");
  expect(await relayBranch(input().value)).toMatchObject({
    blocker: { reason: "relay_worktree_unclean" },
  });
  git(work, "checkout", "--", "child.txt");
  const local = await commit(work, "local.txt", "local\n");
  expect(await relayBranch(input().value)).toMatchObject({
    blocker: { reason: "relay_worktree_unsynced" },
  });
  expect(git(work, "rev-parse", "HEAD")).toBe(local);
  expect(git(remote, "rev-parse", "refs/heads/task/child")).toBe(childHead);
});

test("a recorded rebase is pushed after a restart without a second rebase", async () => {
  const first = input({ retarget: async () => "GitHub refused." });
  expect(await relayBranch(first.value)).toMatchObject({
    blocker: { reason: "relay_retarget_failed" },
  });
  const rebased = git(work, "rev-parse", "HEAD");
  // Main moves on, but the recorded rebase is kept rather than rebased again.
  git(work, "push", "-q", "origin", `${parentHead}:refs/heads/main`, "--force");
  const restarted = input({ head: rebased, rebasedHead: rebased });
  expect(await relayBranch(restarted.value)).toEqual({ head: rebased });
  expect(restarted.calls).toEqual({ recorded: [], retargeted: 1 });
});

test("a moved remote branch fails the push with a lease, and the rebased commits stay", async () => {
  git(work, "push", "-q", "origin", `${parentHead}:refs/heads/task/child`, "--force");
  const { calls, value } = input();
  expect(await relayBranch(value)).toMatchObject({ blocker: { reason: "relay_push_failed" } });
  expect(calls.recorded).toEqual([git(work, "rev-parse", "HEAD")]);
  expect(calls.retargeted).toBe(0);
  expect(git(remote, "rev-parse", "refs/heads/task/child")).toBe(parentHead);
});

test("a lost claim stops before the push, and a branch without a remote is not relayed", async () => {
  const lost = input({ recordRebase: async () => false });
  expect(await relayBranch(lost.value)).toMatchObject({ blocker: { reason: "relay_claim_lost" } });
  expect(git(remote, "rev-parse", "refs/heads/task/child")).toBe(childHead);
  git(work, "config", "--unset", "branch.task/child.remote");
  expect(await relayBranch(input().value)).toMatchObject({
    blocker: { reason: "relay_remote_missing" },
  });
});

test("a rebase that a stopped relay left in progress is a blocker, never a pushed relay", async () => {
  const second = await commit(work, "child2.txt", "child2\n");
  git(work, "push", "-q", "origin", "task/child");
  git(work, "fetch", "-q", "origin");
  // A killed relay leaves a rebase that applied only the first child commit.
  Bun.spawnSync(["git", "rebase", "-i", "--onto", "origin/main", parentHead], {
    cwd: work,
    env: { ...env, GIT_SEQUENCE_EDITOR: "sed -i.bak '1a\\\nbreak\n'" },
  });
  const { calls, value } = input({ head: second });
  expect(await relayBranch(value)).toMatchObject({
    blocker: { reason: "relay_rebase_in_progress" },
  });
  expect(calls).toEqual({ recorded: [], retargeted: 0 });
  expect(git(remote, "rev-parse", "refs/heads/task/child")).toBe(second);
});

test("another branch checked out in the worktree never replaces the PR branch", async () => {
  git(work, "switch", "-q", "main");
  git(work, "merge", "-q", "--ff-only", "origin/main");
  const { calls, value } = input();
  expect(await relayBranch(value)).toMatchObject({
    blocker: { reason: "relay_worktree_branch" },
  });
  expect(calls).toEqual({ recorded: [], retargeted: 0 });
  expect(git(remote, "rev-parse", "refs/heads/task/child")).toBe(childHead);
});
