import { afterAll, afterEach, expect, mock, spyOn, test } from "bun:test";
// Bun has no temporary-directory, chmod, or recursive removal API.
import { chmod, mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ToolInvocation } from "../tool-invocation/main.ts";
import { githubRemote, inspectCheckout } from "./checkout.ts";

const root = await realpath(await mkdtemp(path.join(tmpdir(), "operator-checkout-")));
afterEach(() => {
  mock.restore();
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

async function git(...args: string[]) {
  const child = Bun.spawn(["git", ...args], { stdout: "pipe", stderr: "pipe" });
  expect(await child.exited).toBe(0);
}

function answers(...results: Awaited<ReturnType<typeof ToolInvocation.run>>[]) {
  const spy = spyOn(ToolInvocation, "run");
  for (const result of results) spy.mockResolvedValueOnce(result);
  return spy;
}

function completed(stdout: string) {
  return { status: "completed" as const, exitCode: 0, stdout, stderr: "" };
}

test("inspects real Git metadata, reads fetch URLs only, and sorts distinct identities", async () => {
  const repo = `${root}/repo`;
  await mkdir(`${repo}/nested`, { recursive: true });
  await git("init", "-q", repo);
  await git("-C", repo, "remote", "add", "first", "git@github.com:Zeta/Repo.git");
  await git("-C", repo, "remote", "add", "second", "https://github.com/zeta/repo.git");
  await git("-C", repo, "remote", "add", "third", "https://github.com/alpha/repo");
  await git("-C", repo, "remote", "add", "other", "https://gitlab.com/beta/repo");
  await git("-C", repo, "remote", "set-url", "--push", "third", "https://github.com/push/only");
  expect(await inspectCheckout(`${repo}/nested`)).toEqual({
    checkout: repo,
    repositories: ["alpha/repo", "zeta/repo"],
  });
});

test("a checkout with no remote has no identities", async () => {
  await git("init", "-q", `${root}/lonely`);
  expect(await inspectCheckout(`${root}/lonely`)).toEqual({
    checkout: `${root}/lonely`,
    repositories: [],
  });
});

test("refuses bare repositories, legacy state, and linked worktrees", async () => {
  await git("init", "-q", "--bare", `${root}/bare.git`);
  expect(await inspectCheckout(`${root}/bare.git`)).toEqual({
    reason: "bare_repository",
    detail: "A bare repository cannot be a controlling checkout. Use its main non-bare checkout.",
  });
  await git("init", "-q", `${root}/legacy`);
  await symlink(`${root}/absent`, `${root}/legacy/.operator`);
  expect(await inspectCheckout(`${root}/legacy`)).toEqual({
    reason: "legacy_project_state",
    detail:
      "This checkout has legacy .operator state. Finish old work with the old release. Then the person must remove that folder before using this release. Operator does not migrate, delete, or repair it.",
  });
  await git("init", "-q", `${root}/main`);
  await git(
    "-C",
    `${root}/main`,
    "-c",
    "user.name=Operator",
    "-c",
    "user.email=operator@example.com",
    "commit",
    "-q",
    "--allow-empty",
    "-m",
    "start",
  );
  await git("-C", `${root}/main`, "worktree", "add", "-q", `${root}/linked`);
  expect(await inspectCheckout(`${root}/linked`)).toEqual({
    reason: "linked_checkout",
    detail: `A linked worktree cannot control a project. Use the main checkout associated with ${root}/main/.git.`,
  });
});

test("an unreadable legacy probe is a filesystem error, not a missing folder", async () => {
  const locked = `${root}/locked`;
  await mkdir(locked);
  await chmod(locked, 0o600);
  // A swallowed probe failure would reach these answers and resolve.
  answers(
    completed("false\n"),
    completed(`${locked}\n`),
    completed(root),
    completed(root),
    completed(""),
  );
  try {
    await expect(inspectCheckout(locked)).rejects.toMatchObject({ code: "EACCES" });
  } finally {
    await chmod(locked, 0o755);
  }
});

test("returns the refusal of each Git observation that fails", async () => {
  const empty = `${root}/empty`;
  await mkdir(`${empty}/.git`, { recursive: true });
  const failed = { status: "completed" as const, exitCode: 128, stdout: "", stderr: "" };
  const fallback = {
    reason: "git_checkout_invalid",
    detail: "Git could not resolve this checkout.",
  } as const;
  const steps = [
    completed("false"),
    completed(empty),
    completed(`${empty}/.git`),
    completed(`${empty}/.git`),
  ];
  for (let index = 0; index <= steps.length; index++) {
    const spy = answers(...steps.slice(0, index), failed);
    expect(await inspectCheckout(empty)).toEqual(fallback);
    expect(spy).toHaveBeenCalledTimes(index + 1);
    mock.restore();
  }
  const spy = answers({ status: "unavailable", tool: "git", detail: "not installed" });
  expect(await inspectCheckout(empty)).toEqual({
    reason: "git_unavailable",
    detail: "not installed",
  });
  expect(spy).toHaveBeenCalledWith({
    tool: "git",
    args: ["rev-parse", "--is-bare-repository"],
    cwd: empty,
    timeoutMs: 10000,
  });
  mock.restore();
  answers({ status: "no-answer", detail: "interrupted" });
  expect(await inspectCheckout(empty)).toEqual({
    reason: "git_unavailable",
    detail: "interrupted",
  });
  mock.restore();
  answers({ status: "completed", exitCode: 128, stdout: "", stderr: "  not a repository\n" });
  expect(await inspectCheckout(empty)).toEqual({
    reason: "git_checkout_invalid",
    detail: "not a repository",
  });
});

test("names the first configured remote whose URL names the repository", async () => {
  const repo = `${root}/remotes`;
  await git("init", "-q", repo);
  await git("-C", repo, "config", "foo.remote.decoy.url", "https://github.com/owner/repo");
  await git("-C", repo, "remote", "add", "fork", "https://github.com/other/repo");
  await git("-C", repo, "remote", "add", "up.stream", "git@github.com:Owner/Repo.git");
  await git("-C", repo, "config", "remote.spaced.url", "https://github.com/owner/spaced extra");
  expect(await githubRemote(repo, "owner/repo")).toBe("up.stream");
  expect(await githubRemote(repo, "other/repo")).toBe("fork");
  expect(await githubRemote(repo, "owner/spaced")).toBeNull();
  expect(await githubRemote(repo, "absent/repo")).toBeNull();
  expect(await githubRemote(root, "owner/repo")).toBeNull();
});
