import { afterEach, beforeEach, expect, test } from "bun:test";
// Bun has no temporary-directory, realpath, or recursive removal API.
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Environment } from "../environment/main.ts";
import { cleanWorktree } from "./worktree-cleanup.ts";

let root = "";
let checkout = "";
let worktree = "";
const env = Environment.child({
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "Fixture",
  GIT_AUTHOR_EMAIL: "fixture@example.com",
  GIT_COMMITTER_NAME: "Fixture",
  GIT_COMMITTER_EMAIL: "fixture@example.com",
});

function git(cwd: string, ...args: string[]) {
  const result = Bun.spawnSync(["git", ...args], { cwd, env, stderr: "pipe" });
  expect(result.exitCode, result.stderr.toString()).toBe(0);
  return result.stdout.toString().trim();
}

beforeEach(async () => {
  root = await realpath(await mkdtemp(path.join(tmpdir(), "operator-report-worktree-")));
  checkout = `${root}/checkout`;
  worktree = `${root}/worktree`;
  await Bun.write(`${checkout}/.gitignore`, ".env*\nnode_modules\ndist\n", { createPath: true });
  git(checkout, "init", "-q", "-b", "main");
  git(checkout, "add", ".");
  git(checkout, "commit", "-q", "-m", "fixture");
  await Bun.write(`${checkout}/.env.local`, "TOKEN=1\n");
  git(checkout, "worktree", "add", "-q", "-b", "task/read", worktree);
  // Prepared project inputs are not unlanded work.
  await Bun.write(`${worktree}/.env.local`, "TOKEN=1\n");
  await Bun.write(`${worktree}/node_modules/pkg/index.js`, "x\n", { createPath: true });
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

test("a worktree with only prepared inputs and landed commits is removed with its branch", async () => {
  expect(await cleanWorktree({ checkout, worktree, branch: "task/read" })).toMatchObject({
    state: "removed",
    detail: expect.stringContaining("and its branch task/read") as unknown,
  });
  expect(await Bun.file(`${worktree}/.gitignore`).exists()).toBe(false);
  expect(git(checkout, "branch", "--list", "task/read")).toBe("");
  expect(await cleanWorktree({ checkout, worktree, branch: "task/read" })).toMatchObject({
    state: "absent",
  });
});

test.each([
  {
    name: "an untracked file",
    change: () => Bun.write(`${worktree}/notes.md`, "notes\n"),
    reason: "changed or untracked notes.md",
  },
  {
    name: "a tracked change",
    change: () => Bun.write(`${worktree}/.gitignore`, "changed\n"),
    reason: "changed or untracked .gitignore",
  },
  {
    name: "an ignored build file",
    change: () => Bun.write(`${worktree}/dist/out.js`, "x\n", { createPath: true }),
    reason: "ignored dist",
  },
  {
    name: "a changed environment file",
    change: () => Bun.write(`${worktree}/.env.local`, "TOKEN=2\n"),
    reason: "ignored .env.local",
  },
  {
    name: "a commit that only this branch holds",
    change: async () => {
      await Bun.write(`${worktree}/a.ts`, "x\n");
      git(worktree, "add", "a.ts");
      git(worktree, "commit", "-q", "-m", "work");
    },
    reason: "commits that no other branch or remote branch holds",
  },
  {
    name: "a branch commit while HEAD is detached elsewhere",
    change: async () => {
      await Bun.write(`${worktree}/a.ts`, "x\n");
      git(worktree, "add", "a.ts");
      git(worktree, "commit", "-q", "-m", "work");
      git(worktree, "checkout", "-q", "--detach", "main");
    },
    reason: "commits that no other branch or remote branch holds",
  },
])("a worktree with $name is kept", async ({ change, reason }) => {
  await change();
  const outcome = await cleanWorktree({ checkout, worktree, branch: "task/read" });
  expect(outcome).toMatchObject({ state: "kept" });
  expect(outcome.detail).toContain(reason);
  expect(outcome.detail).toContain("Only the person can authorize its deletion.");
  expect(await Bun.file(`${worktree}/.gitignore`).exists()).toBe(true);
  expect(git(checkout, "branch", "--list", "task/read")).toContain("task/read");
});
