import { afterAll, afterEach, beforeAll, beforeEach, expect, mock, spyOn, test } from "bun:test";
// Bun has no temporary-directory, realpath, folder, recursive copy, or recursive removal API.
import { cp, mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Environment } from "../environment/main.ts";
import { ToolInvocation } from "../tool-invocation/main.ts";
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
// The fixture is built once at a fixed root and restored from a copy before each test, so the
// absolute remote path stays valid.
let base = "";
beforeAll(async () => {
  base = await realpath(await mkdtemp(path.join(tmpdir(), "operator-relay-")));
  root = `${base}/run`;
  await mkdir(root);
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
  // A fetch without the default branch name would read the parent's branch instead.
  git(remote, "symbolic-ref", "HEAD", "refs/heads/task/parent");
  await cp(root, `${base}/template`, { recursive: true, verbatimSymlinks: true });
});
beforeEach(async () => {
  await rm(root, { recursive: true, force: true });
  await cp(`${base}/template`, root, { recursive: true, verbatimSymlinks: true });
});
afterAll(async () => {
  await rm(base, { recursive: true, force: true });
});
afterEach(() => {
  mock.restore();
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

const kept = "Your branch and worktree are unchanged.";

test("each blocker explains the stop and the next step", async () => {
  await Bun.write(`${work}/child.txt`, "changed\n");
  expect(await relayBranch(input().value)).toEqual({
    blocker: {
      reason: "relay_worktree_unclean",
      detail: `Commit or remove the changed files, push, then wait again. ${kept}`,
    },
  });
  git(work, "checkout", "--", "child.txt");
  const local = await commit(work, "local.txt", "local\n");
  expect(await relayBranch(input().value)).toEqual({
    blocker: {
      reason: "relay_worktree_unsynced",
      detail: `The worktree is at ${local}, but the PR head is ${childHead}. Push or pull, then wait again. ${kept}`,
    },
  });
  git(work, "reset", "-q", "--hard", childHead);
  expect(await relayBranch(input({ recordRebase: async () => false }).value)).toEqual({
    blocker: {
      reason: "relay_claim_lost",
      detail: "Another process took over the relay. Wait again.",
    },
  });
  git(work, "reset", "-q", "--hard", childHead);
  expect(await relayBranch(input({ retarget: async () => "http_422: Refused" }).value)).toEqual({
    blocker: {
      reason: "relay_retarget_failed",
      detail:
        "The branch is pushed, but GitHub did not change the PR base to main: http_422: Refused Wait again to retry.",
    },
  });
  git(work, "switch", "-q", "--detach");
  expect(await relayBranch(input().value)).toEqual({
    blocker: {
      reason: "relay_worktree_branch",
      detail: `The worktree must be on task/child, not a detached HEAD. Switch back, then wait again. ${kept}`,
    },
  });
  git(work, "switch", "-q", "task/parent");
  expect(await relayBranch(input().value)).toMatchObject({
    blocker: {
      detail: `The worktree must be on task/child, not refs/heads/task/parent. Switch back, then wait again. ${kept}`,
    },
  });
  git(work, "switch", "-q", "task/child");
  git(work, "config", "--unset", "branch.task/child.remote");
  expect(await relayBranch(input().value)).toEqual({
    blocker: {
      reason: "relay_remote_missing",
      detail: `Branch task/child has no remote. Push it with git push -u, then wait again. ${kept}`,
    },
  });
  git(work, "config", "branch.task/child.remote", "");
  expect(await relayBranch(input().value)).toMatchObject({
    blocker: { reason: "relay_remote_missing" },
  });
});

test("a rebase in progress is reported with its own detail", async () => {
  await Bun.write(
    git(work, "rev-parse", "--path-format=absolute", "--git-path", "rebase-apply") + "/x",
    "",
    { createPath: true },
  );
  expect(await relayBranch(input().value)).toEqual({
    blocker: {
      reason: "relay_rebase_in_progress",
      detail: `A rebase is in progress in the worktree. Finish or abort it, push, then wait again. ${kept}`,
    },
  });
});

test("a remote or parent head that Git cannot fetch stops the relay", async () => {
  const missing = "0".repeat(40);
  const parent = await relayBranch(input({ parentHead: missing }).value);
  expect(parent).toMatchObject({
    blocker: {
      reason: "relay_fetch_failed",
      detail: expect.stringMatching(
        new RegExp(`^Git could not fetch the parent head ${missing}: \\S.* ${kept}$`, "s"),
      ) as unknown,
    },
  });
  git(work, "remote", "set-url", "origin", `${root}/gone.git`);
  expect(await relayBranch(input().value)).toMatchObject({
    blocker: {
      reason: "relay_fetch_failed",
      detail: expect.stringMatching(
        new RegExp(`^Git could not fetch main: \\S.* ${kept}$`, "s"),
      ) as unknown,
    },
  });
  expect(git(work, "rev-parse", "HEAD")).toBe(childHead);
});

test("a parent head that only the remote holds is fetched before the rebase", async () => {
  const other = `${root}/other`;
  git(root, "clone", "-q", remote, other);
  git(other, "switch", "-q", "task/parent");
  for (const [key, value] of [
    ["user.name", "Fixture"],
    ["user.email", "fixture@example.com"],
    ["commit.gpgsign", "false"],
  ] as const)
    git(other, "config", key, value);
  const remoteParent = await commit(other, "late.txt", "late\n");
  git(other, "push", "-q", "origin", "task/parent:refs/heads/side");
  const { value } = input({ parentHead: remoteParent });
  const result = await relayBranch(value);
  expect(result).toEqual({ head: git(work, "rev-parse", "HEAD") });
  expect(git(work, "cat-file", "-t", remoteParent)).toBe("commit");
});

test("a conflicting rebase is aborted and the worktree keeps the PR head", async () => {
  git(work, "fetch", "-q", "origin");
  git(work, "switch", "-q", "main");
  git(work, "reset", "-q", "--hard", "origin/main");
  await commit(work, "README.md", "main change\n");
  git(work, "push", "-q", "origin", "main");
  git(work, "switch", "-q", "task/child");
  const head = await commit(work, "README.md", "child change\n");
  git(work, "push", "-q", "origin", "task/child");
  const { calls, value } = input({ head });
  expect(await relayBranch(value)).toEqual({
    blocker: {
      reason: "relay_conflict",
      detail: `The rebase onto main has conflicts in: README.md. The rebase was aborted. ${kept} Rebase onto main yourself, push, then wait again.`,
    },
  });
  expect(git(work, "rev-parse", "HEAD")).toBe(head);
  expect(git(work, "status", "--porcelain")).toBe("");
  expect(calls).toEqual({ recorded: [], retargeted: 0 });
});

test("a PR head that the owner already rebased onto main is only retargeted", async () => {
  git(work, "fetch", "-q", "origin");
  git(work, "rebase", "-q", "--onto", "origin/main", parentHead);
  git(work, "push", "-q", "--force", "origin", "task/child");
  const head = git(work, "rev-parse", "HEAD");
  const { calls, value } = input({ head });
  expect(await relayBranch(value)).toEqual({ head });
  expect(calls).toEqual({ recorded: [], retargeted: 1 });
  // The unchanged PR head on the parent's branch still needs its rebase.
  git(work, "reset", "-q", "--hard", childHead);
  git(work, "push", "-q", "--force", "origin", "task/child");
  const again = input();
  expect(await relayBranch(again.value)).toEqual({ head: git(work, "rev-parse", "HEAD") });
  expect(again.calls.recorded).toHaveLength(1);
});

test("each parent blocker names the parent and the branch", () => {
  const relay = stacked(parent);
  const merged = { state: "MERGED" as const, base: "main", head: "p1" };
  expect(decideRelay(relay, open, { ...merged, state: "CLOSED" })).toEqual({
    action: "blocked",
    blocker: {
      reason: "relay_parent_closed",
      detail:
        "Parent PR #6 was closed without a merge. Your PR still targets task/parent. Ask your SuperAgent.",
    },
  });
  expect(decideRelay(relay, open, { ...merged, base: "release" })).toEqual({
    action: "blocked",
    blocker: {
      reason: "relay_parent_base",
      detail: "Parent PR #6 merged into release, not the default branch. Ask your SuperAgent.",
    },
  });
});

test("a recorded relay keeps every field", () => {
  const blocked = {
    ...stacked(parent),
    state: "blocked" as const,
    rebasedHead: "r1",
    blocker: { reason: "relay_conflict", detail: "Rebase yourself." },
    ownerPid: 12,
    leaseAt: "2026-01-01T00:00:00.000Z",
  };
  expect(relaySchema.parse(blocked)).toEqual(blocked);
  expect(relaySchema.parse({ ...blocked, state: "relayed" }).state).toBe("relayed");
  expect(relaySchema.safeParse({ ...blocked, blocker: { reason: "x" } }).success).toBe(false);
});

/** Answers the Git commands that `answer` selects, and runs the rest. */
function gitAnswers(
  answer: (args: string[]) => Awaited<ReturnType<typeof ToolInvocation.run>> | null,
) {
  const run = ToolInvocation.run;
  spyOn(ToolInvocation, "run").mockImplementation(
    async (request) => answer(request.args) ?? run(request),
  );
}

test("a Git command without an answer stops the relay with its detail", async () => {
  gitAnswers((args) =>
    args[0] === "fetch" ? { status: "no-answer", detail: "git fetch ended on SIGKILL" } : null,
  );
  expect(await relayBranch(input().value)).toEqual({
    blocker: {
      reason: "relay_fetch_failed",
      detail: `Git could not fetch main: git fetch ended on SIGKILL ${kept}`,
    },
  });
  mock.restore();
  gitAnswers((args) =>
    args[0] === "symbolic-ref" ? { status: "no-answer", detail: "git ended" } : null,
  );
  expect(await relayBranch(input().value)).toMatchObject({
    blocker: {
      detail: `The worktree must be on task/child, not a detached HEAD. Switch back, then wait again. ${kept}`,
    },
  });
  expect(git(work, "rev-parse", "HEAD")).toBe(childHead);
});

test("a parent head that only this clone holds needs no fetch", async () => {
  git(work, "switch", "-q", "-c", "local-only", "task/parent");
  const localParent = await commit(work, "local.txt", "local\n");
  git(work, "switch", "-q", "task/child");
  const { value } = input({ parentHead: localParent });
  expect(await relayBranch(value)).toEqual({ head: git(work, "rev-parse", "HEAD") });
});

test("a local rebase that is not pushed is unsynced", async () => {
  git(work, "fetch", "-q", "origin");
  git(work, "rebase", "-q", "--onto", "origin/main", parentHead);
  const head = git(work, "rev-parse", "HEAD");
  expect(await relayBranch(input().value)).toEqual({
    blocker: {
      reason: "relay_worktree_unsynced",
      detail: `The worktree is at ${head}, but the PR head is ${childHead}. Push or pull, then wait again. ${kept}`,
    },
  });
});

test("a conflict without readable files or a failed abort keeps all work", async () => {
  git(work, "fetch", "-q", "origin");
  git(work, "switch", "-q", "main");
  git(work, "reset", "-q", "--hard", "origin/main");
  await Bun.write(`${work}/README.md`, "main change\n");
  await Bun.write(`${work}/both.txt`, "main both\n");
  git(work, "add", ".");
  git(work, "commit", "-q", "-m", "main");
  git(work, "push", "-q", "origin", "main");
  git(work, "switch", "-q", "task/child");
  await Bun.write(`${work}/README.md`, "child change\n");
  await Bun.write(`${work}/both.txt`, "child both\n");
  git(work, "add", ".");
  git(work, "commit", "-q", "-m", "child");
  git(work, "push", "-q", "origin", "task/child");
  const head = git(work, "rev-parse", "HEAD");
  gitAnswers((args) => (args[0] === "diff" ? { status: "no-answer", detail: "git ended" } : null));
  expect(await relayBranch(input({ head }).value)).toEqual({
    blocker: {
      reason: "relay_conflict",
      detail: `The rebase onto main has conflicts in: unknown files. The rebase was aborted. ${kept} Rebase onto main yourself, push, then wait again.`,
    },
  });
  expect(git(work, "rev-parse", "HEAD")).toBe(head);
  mock.restore();
  gitAnswers((args) =>
    args[0] === "rebase" && args[1] === "--abort"
      ? { status: "completed", exitCode: 1, stdout: "", stderr: "abort refused\n" }
      : null,
  );
  expect(await relayBranch(input({ head }).value)).toEqual({
    blocker: {
      reason: "relay_conflict",
      detail:
        "The rebase onto main failed and could not be aborted: abort refused. Inspect the worktree. Keep all work.",
    },
  });
  mock.restore();
  git(work, "rebase", "--abort");
  const conflicts = await relayBranch(input({ head }).value);
  expect(conflicts).toMatchObject({
    blocker: { detail: expect.stringContaining("conflicts in: README.md, both.txt.") as unknown },
  });
});

test("a pushed relay is not pushed again, and a refused push keeps the rebased commits", async () => {
  const first = input({ retarget: async () => "GitHub refused." });
  await relayBranch(first.value);
  const rebased = git(work, "rev-parse", "HEAD");
  const hook = `${work}/.git/hooks/pre-push`;
  await Bun.write(hook, "#!/bin/sh\necho hook refused >&2\nexit 1\n");
  Bun.spawnSync(["chmod", "+x", hook]);
  const restarted = input({ head: rebased, rebasedHead: rebased });
  expect(await relayBranch(restarted.value)).toEqual({ head: rebased });
  git(work, "reset", "-q", "--hard", childHead);
  git(work, "push", "-q", "--force", "--no-verify", "origin", "task/child");
  const refused = await relayBranch(input().value);
  expect(refused).toMatchObject({
    blocker: {
      reason: "relay_push_failed",
      detail: expect.stringMatching(
        /^Git could not push the rebased task\/child: .*hook refused.* The rebased commits stay in the worktree\.$/s,
      ) as unknown,
    },
  });
});
