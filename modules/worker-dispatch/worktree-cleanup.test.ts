import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
// Bun has no temporary-directory, realpath, or recursive removal API.
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DeviceState } from "../device-state/main.ts";
import { Environment } from "../environment/main.ts";
import { OperatorHome } from "../operator-home/main.ts";
import { ToolInvocation } from "../tool-invocation/main.ts";
import { cleanWorktree } from "./worktree-cleanup.ts";

let root = "";
let checkout = "";
let worktree = "";
let paths: ReturnType<typeof OperatorHome.resolve>;
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
  await Bun.write(`${checkout}/.gitignore`, ".env*\nnode_modules\ndist\n*.log\nx.env.local\n", {
    createPath: true,
  });
  git(checkout, "init", "-q", "-b", "main");
  git(checkout, "add", ".");
  git(checkout, "commit", "-q", "-m", "fixture");
  // A tracked manifest and Bun lockfile make dependencies preparation output.
  await Bun.write(`${checkout}/package.json`, "{}\n");
  await Bun.write(`${checkout}/bun.lock`, "lock\n");
  git(checkout, "add", ".");
  git(checkout, "commit", "-q", "-m", "dependencies");
  await Bun.write(`${checkout}/.env.local`, "TOKEN=1\n");
  git(checkout, "worktree", "add", "-q", "-b", "task/read", worktree);
  paths = OperatorHome.resolve(Environment.parse({ HOME: `${root}/home`, NODE_ENV: "test" }));
  expect(
    DeviceState.registerProject(paths, {
      repository: "example/one",
      checkout,
      registeredAt: "now",
    }).tag,
  ).toBe("Ok");
  prepared(worktree);
  // Prepared project inputs are not unlanded work.
  await Bun.write(`${worktree}/.env.local`, "TOKEN=1\n");
  await Bun.write(`${worktree}/node_modules/pkg/index.js`, "x\n", { createPath: true });
});
function prepared(folder: string) {
  DeviceState.beginPreparation(paths, folder, "example/one");
  DeviceState.finishPreparation(paths, folder, { state: "prepared", detail: "done" });
}

afterEach(async () => {
  mock.restore();
  await rm(root, { recursive: true, force: true });
});

test("a worktree with only prepared inputs and landed commits is removed with its branch", async () => {
  expect(await cleanWorktree({ paths, checkout, worktree, branch: "task/read" })).toEqual({
    state: "removed",
    detail: `Removed worktree ${worktree} and its branch task/read, whose commits other branches hold.`,
  });
  expect(await Bun.file(`${worktree}/.gitignore`).exists()).toBe(false);
  expect(git(checkout, "branch", "--list", "task/read")).toBe("");
  expect(await cleanWorktree({ paths, checkout, worktree, branch: "task/read" })).toEqual({
    state: "absent",
    detail: `Worktree ${worktree} no longer exists.`,
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
  const outcome = await cleanWorktree({ paths, checkout, worktree, branch: "task/read" });
  expect(outcome).toMatchObject({ state: "kept" });
  expect(outcome.detail).toContain(reason);
  expect(outcome.detail).toContain("Only the person can authorize its deletion.");
  expect(await Bun.file(`${worktree}/.gitignore`).exists()).toBe(true);
  expect(git(checkout, "branch", "--list", "task/read")).toContain("task/read");
});

test("dependencies that preparation did not install are kept", async () => {
  const old = `${root}/old`;
  // The first commit tracks no Bun lockfile, so preparation installed nothing there.
  git(checkout, "worktree", "add", "-q", "--detach", old, "main~1");
  prepared(old);
  await Bun.write(`${old}/node_modules/pkg/index.js`, "x\n", { createPath: true });
  const outcome = await cleanWorktree({ paths, checkout, worktree: old, branch: null });
  expect(outcome).toMatchObject({ state: "kept" });
  expect(outcome.detail).toContain("ignored node_modules");
  expect(await Bun.file(`${old}/node_modules/pkg/index.js`).exists()).toBe(true);
});

test("an unprepared worktree keeps its ignored files", async () => {
  const plain = `${root}/plain-worktree`;
  git(checkout, "worktree", "add", "-q", "--detach", plain, "main");
  await Bun.write(`${plain}/node_modules/pkg/index.js`, "x\n", { createPath: true });
  const outcome = await cleanWorktree({ paths, checkout, worktree: plain, branch: null });
  expect(outcome).toMatchObject({ state: "kept" });
  expect(outcome.detail).toContain("ignored node_modules");
});

function detached() {
  const path = `${root}/detached`;
  git(checkout, "worktree", "add", "-q", "--detach", path, "main");
  return path;
}

test("a detached worktree with landed commits is removed, and no branch is deleted", async () => {
  const path = detached();
  git(checkout, "branch", "null");
  expect(await cleanWorktree({ paths, checkout, worktree: path, branch: null })).toEqual({
    state: "removed",
    detail: `Removed worktree ${path}.`,
  });
  expect(git(checkout, "branch", "--list", "null")).toContain("null");
  expect(await Bun.file(`${path}/.gitignore`).exists()).toBe(false);
});

test("a detached worktree keeps a commit that only its HEAD holds", async () => {
  const path = detached();
  await Bun.write(`${path}/a.ts`, "x\n");
  git(path, "add", "a.ts");
  git(path, "commit", "-q", "-m", "work");
  expect(await cleanWorktree({ paths, checkout, worktree: path, branch: null })).toMatchObject({
    state: "kept",
    detail: `Kept worktree ${path}, because it holds commits that no other branch or remote branch holds. Only the person can authorize its deletion.`,
  });
});

test("with no recorded branch, every branch counts as landing, also one named null", async () => {
  const path = detached();
  await Bun.write(`${path}/a.ts`, "x\n");
  git(path, "add", "a.ts");
  git(path, "commit", "-q", "-m", "work");
  git(path, "branch", "null");
  expect(await cleanWorktree({ paths, checkout, worktree: path, branch: null })).toMatchObject({
    state: "removed",
  });
  expect(git(checkout, "branch", "--list", "null")).toContain("null");
});

test("a recorded branch that is already gone is not inspected, and its deletion fails", async () => {
  git(worktree, "checkout", "-q", "--detach", "main");
  git(checkout, "branch", "-D", "task/read");
  // A remote ref whose name ends like the branch ref is not the branch.
  git(checkout, "update-ref", "refs/remotes/origin/refs/heads/task/read", "main");
  await expect(cleanWorktree({ paths, checkout, worktree, branch: "task/read" })).rejects.toThrow(
    "git branch -D failed: error: branch 'task/read' not found",
  );
  expect(await Bun.file(`${worktree}/.gitignore`).exists()).toBe(false);
});

test("ignored files are prepared inputs only as unchanged local environment copies", async () => {
  for (const file of [".env.development.local", ".env.local.bak", "x.env.local", "build.log"]) {
    await Bun.write(`${checkout}/${file}`, "same\n");
    await Bun.write(`${worktree}/${file}`, "same\n");
  }
  await Bun.write(`${worktree}/.env.test.local`, "only here\n");
  await Bun.write(`${checkout}/pkg/README.md`, "pkg\n", { createPath: true });
  git(checkout, "add", "pkg");
  git(checkout, "commit", "-q", "-m", "pkg");
  git(worktree, "merge", "-q", "--ff-only", "main");
  await Bun.write(`${worktree}/pkg/dist/out.js`, "x\n", { createPath: true });
  expect(await cleanWorktree({ paths, checkout, worktree, branch: "task/read" })).toEqual({
    state: "kept",
    detail: `Kept worktree ${worktree}, because it holds ignored .env.local.bak, ignored .env.test.local, ignored build.log, ignored pkg/dist, ignored x.env.local. Only the person can authorize its deletion.`,
  });
});

test("a Git failure names the command and Git's trimmed message", async () => {
  await Bun.write(`${root}/plain/file`, "x\n", { createPath: true });
  await expect(
    cleanWorktree({ paths, checkout, worktree: `${root}/plain`, branch: "task/read" }),
  ).rejects.toThrow(
    new Error(
      "git status --porcelain failed: fatal: not a git repository (or any of the parent directories): .git",
    ),
  );
  spyOn(ToolInvocation, "run").mockResolvedValue({
    status: "unavailable",
    tool: "git",
    detail: "git is not on the path.",
  });
  await expect(cleanWorktree({ paths, checkout, worktree, branch: "task/read" })).rejects.toThrow(
    new Error("git status --porcelain failed: git is not on the path."),
  );
});

test.each([
  { status: "completed" as const, exitCode: 128, stdout: "", stderr: "fatal" },
  { status: "no-answer" as const, detail: "git ended" },
])("a branch check that Git cannot answer fails the cleanup", async (answer) => {
  const run = ToolInvocation.run;
  spyOn(ToolInvocation, "run").mockImplementation((input) =>
    input.args.includes("show-ref") ? Promise.resolve(answer) : run(input),
  );
  await expect(cleanWorktree({ paths, checkout, worktree, branch: "task/read" })).rejects.toThrow(
    new Error("git show-ref failed for task/read."),
  );
  expect(await Bun.file(`${worktree}/.gitignore`).exists()).toBe(true);
});
