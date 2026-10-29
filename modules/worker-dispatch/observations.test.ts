import { afterEach, beforeEach, expect, mock, setSystemTime, spyOn, test } from "bun:test";
// Bun has no temporary-directory, realpath, symlink, or recursive removal API.
import { mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Err, ErrAsync, Ok, OkAsync } from "unthrown";
import { DeviceState } from "../device-state/main.ts";
import { Environment } from "../environment/main.ts";
import { Herdr } from "../herdr/main.ts";
import { OperatorHome } from "../operator-home/main.ts";
import { ToolInvocation } from "../tool-invocation/main.ts";
import {
  gitBranches,
  listFiles,
  parentBase,
  projectWorkspace,
  qualify,
  waitForPreparation,
} from "./observations.ts";

let root = "";
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

async function repository(name: string) {
  const directory = `${root}/${name}`;
  await Bun.write(`${directory}/README.md`, `${name}\n`, { createPath: true });
  git(directory, "init", "-q", "-b", "main");
  git(directory, "add", ".");
  git(directory, "commit", "-q", "-m", "fixture");
  return directory;
}

beforeEach(async () => {
  root = await realpath(await mkdtemp(path.join(tmpdir(), "operator-observations-")));
});
afterEach(async () => {
  mock.restore();
  setSystemTime();
  await rm(root, { recursive: true, force: true });
});

test("qualifies each known filesystem failure and leaves every other cause a defect", () => {
  function defect(cause: Error) {
    return { defect: String(cause) };
  }
  for (const code of ["ENOENT", "EACCES", "EPERM", "EIO", "EROFS", "ENOSPC", "ENOTDIR"])
    expect(qualify(Object.assign(new Error(`failed ${code}`), { code }), defect)).toEqual({
      reason: "dispatch_io_failed",
      detail: `Error: failed ${code}`,
    });
  for (const code of ["EISDIR", "ELOOP"])
    expect(qualify(Object.assign(new Error("x"), { code }), defect)).toMatchObject({
      reason: "dispatch_io_failed",
    });
  expect(qualify(Object.assign(new Error("busy"), { code: "EBUSY" }), defect)).toEqual({
    defect: "Error: busy",
  });
  expect(qualify(new Error("plain"), defect)).toEqual({ defect: "Error: plain" });
});

test("lists every file below a folder in sorted order, and a missing folder has none", async () => {
  await Bun.write(`${root}/reports/b.md`, "b\n", { createPath: true });
  await Bun.write(`${root}/reports/a/2/files/notes.md`, "n\n", { createPath: true });
  await Bun.write(`${root}/reports/a/1.md`, "a\n", { createPath: true });
  await mkdir(`${root}/reports/empty`);
  expect(await listFiles(`${root}/reports`)).toEqual(["a/1.md", "a/2/files/notes.md", "b.md"]);
  expect(await listFiles(`${root}/missing`)).toEqual([]);
});

test("lists local branches and origin branches without the remote name", async () => {
  const origin = await repository("origin");
  git(origin, "branch", "pushed");
  const checkout = `${root}/checkout`;
  git(root, "clone", "-q", origin, checkout);
  git(checkout, "branch", "local");
  git(checkout, "branch", "team/origin/x");
  expect((await gitBranches(checkout)).getOr(null)).toEqual(
    new Set(["local", "main", "team/origin/x", "HEAD", "pushed"]),
  );
});

test("a folder that is not a Git checkout has no branch list", async () => {
  expect(await gitBranches(root)).toMatchObject({
    tag: "Err",
    error: {
      reason: "git_unavailable",
      detail: "Git could not list the project branches. Nothing was launched.",
    },
  });
});

test("Git that cannot start is a qualified failure, and a non-Error rejection a defect", async () => {
  const run = spyOn(ToolInvocation, "run");
  run.mockRejectedValue(Object.assign(new Error("denied"), { code: "EACCES" }));
  expect(await gitBranches(root)).toMatchObject({
    tag: "Err",
    error: { reason: "dispatch_io_failed", detail: "Error: denied" },
  });
  run.mockRejectedValue("stopped");
  expect(await gitBranches(root)).toMatchObject({ tag: "Defect", cause: "stopped" });
  expect(await parentBase(root, "parent")).toMatchObject({ tag: "Defect", cause: "stopped" });
});

test("a parent branch starts its child at the pushed head, through a private ref", async () => {
  const origin = await repository("origin");
  const checkout = `${root}/checkout`;
  git(root, "clone", "-q", origin, checkout);
  git(checkout, "checkout", "-q", "-b", "parent");
  await Bun.write(`${checkout}/a.ts`, "a\n");
  git(checkout, "add", "a.ts");
  git(checkout, "commit", "-q", "-m", "parent work");
  git(checkout, "push", "-q", "-u", "origin", "parent");
  const pushed = git(checkout, "rev-parse", "HEAD");
  // A later local commit is not pushed, so the child does not start on it.
  await Bun.write(`${checkout}/b.ts`, "b\n");
  git(checkout, "add", "b.ts");
  git(checkout, "commit", "-q", "-m", "local work");
  expect(await parentBase(checkout, "parent")).toMatchObject({ tag: "Ok", value: pushed });
  expect(git(checkout, "for-each-ref", "refs/operator")).toBe("");
  expect(await Bun.file(`${checkout}/.git/FETCH_HEAD`).exists()).toBe(false);
});

test("a parent branch with no upstream, or one gone from its remote, is unavailable", async () => {
  const origin = await repository("origin");
  const checkout = `${root}/checkout`;
  git(root, "clone", "-q", origin, checkout);
  git(origin, "branch", "unlinked");
  git(checkout, "fetch", "-q", "origin");
  git(checkout, "branch", "gone", "main");
  git(checkout, "config", "branch.gone.remote", "origin");
  // A branch with no upstream is never fetched from a guessed remote.
  git(checkout, "remote", "add", "null", origin);
  for (const branch of ["unlinked", "gone"])
    expect(await parentBase(checkout, branch)).toMatchObject({
      tag: "Err",
      error: {
        reason: "parent_branch_unavailable",
        detail: `Git could not fetch the pushed parent branch ${branch}. Its owner must push it with an upstream. Nothing was launched.`,
      },
    });
  expect(git(checkout, "for-each-ref", "refs/operator")).toBe("");
});

test("the project workspace is the first unlinked one whose real checkout is the controller", async () => {
  const checkout = await repository("checkout");
  await symlink(checkout, `${root}/link`);
  spyOn(Herdr, "workspaces").mockReturnValue(
    OkAsync([
      { workspaceId: "w1", label: "none", checkout: null, linked: false },
      { workspaceId: "w2", label: "linked", checkout, linked: true },
      { workspaceId: "w3", label: "other", checkout: root, linked: false },
      { workspaceId: "w4", label: "missing", checkout: `${root}/missing`, linked: false },
      { workspaceId: "w5", label: "one", checkout: `${root}/link`, linked: false },
      { workspaceId: "w6", label: "two", checkout, linked: false },
    ]),
  );
  expect(await projectWorkspace(checkout)).toMatchObject({
    tag: "Ok",
    value: {
      workspaceId: "w5",
      labels: ["none", "linked", "other", "missing", "one", "two"],
    },
  });
});

test("no matching workspace gives none, and a Herdr failure passes through", async () => {
  const checkout = await repository("checkout");
  const workspaces = spyOn(Herdr, "workspaces");
  workspaces.mockReturnValue(OkAsync([{ workspaceId: "w1", label: "wt", checkout, linked: true }]));
  expect(await projectWorkspace(checkout)).toMatchObject({
    tag: "Ok",
    value: { workspaceId: null, labels: ["wt"] },
  });
  const failure = { reason: "herdr_unavailable" as const, detail: "gone" };
  workspaces.mockReturnValue(ErrAsync(failure));
  expect(await projectWorkspace(checkout)).toMatchObject({ tag: "Err", error: failure });
});

function paths() {
  return OperatorHome.resolve({
    ...Environment.read(),
    HOME: root,
    XDG_CONFIG_HOME: `${root}/config`,
    XDG_STATE_HOME: `${root}/state`,
  });
}
const since = "2026-01-01T00:00:00.000Z";
type Row = { state: string; detail: string; startedAt: string; abandoned: boolean };

const clock = Date.parse("2026-03-01T00:00:00.000Z");
// A wait that never ends fails its test here, before the mutation runner's own timeout.
const wait = { timeout: 10000 };

/**
 * Answers the rows in order, and runs `each` before each read. By default each read moves the
 * clock one minute, so a wait that ignores its rows ends at the deadline instead of hanging.
 */
function preparations(
  rows: (Row | null)[],
  each: (read: number) => void = (read) => setSystemTime(clock + (read + 1) * 60_000),
) {
  setSystemTime(clock);
  let read = 0;
  return spyOn(DeviceState, "readPreparation").mockImplementation((_paths, worktree) => {
    each(read);
    const row = rows[Math.min(read++, rows.length - 1)] ?? null;
    return Ok(
      row === null
        ? null
        : {
            path: worktree,
            repository: "example/one",
            finishedAt: null,
            ownerPid: null,
            leaseAt: null,
            ...row,
          },
    );
  });
}

test(
  "waits for this start's finished preparation and ignores an older one",
  async () => {
    const worktree = await repository("worktree");
    const old = { state: "prepared", detail: "old", startedAt: "2025-12-31T00:00:00.000Z" };
    const read = preparations([
      null,
      { ...old, abandoned: false },
      { ...old, state: "running", abandoned: true },
      { state: "running", detail: "", startedAt: since, abandoned: false },
      { state: "prepared", detail: "Copied 1 file.", startedAt: since, abandoned: false },
    ]);
    expect(await waitForPreparation(paths(), `${root}/worktree/.`, since)).toMatchObject({
      tag: "Ok",
      value: "Copied 1 file.",
    });
    expect(read).toHaveBeenCalledTimes(5);
    expect(read.mock.calls[0]?.[1]).toBe(worktree);
  },
  wait,
);

test(
  "a failed or abandoned preparation of this start fails the wait",
  async () => {
    await repository("worktree");
    const later = "2026-01-02T00:00:00.000Z";
    preparations([
      { state: "failed", detail: "bun install failed", startedAt: later, abandoned: false },
    ]);
    expect(await waitForPreparation(paths(), `${root}/worktree`, since)).toMatchObject({
      tag: "Err",
      error: { reason: "worktree_setup_failed", detail: "bun install failed" },
    });
    mock.restore();
    preparations([{ state: "running", detail: "", startedAt: since, abandoned: true }]);
    expect(await waitForPreparation(paths(), `${root}/worktree`, since)).toMatchObject({
      tag: "Err",
      error: {
        reason: "worktree_setup_failed",
        detail: "The Herdr worktree hook stopped before it recorded a preparation outcome.",
      },
    });
  },
  wait,
);

test(
  "a missing worktree or an unreadable state fails before any wait",
  async () => {
    const read = preparations([null]);
    expect(await waitForPreparation(paths(), `${root}/missing`, since)).toMatchObject({
      tag: "Err",
      error: {
        reason: "worktree_missing",
        detail: `Herdr returned ${root}/missing, but it does not exist.`,
      },
    });
    expect(read).not.toHaveBeenCalled();
    await repository("worktree");
    const failure = { reason: "state_busy" as const, detail: "locked" };
    read.mockReturnValue(Err(failure));
    expect(await waitForPreparation(paths(), `${root}/worktree`, since)).toMatchObject({
      tag: "Err",
      error: failure,
    });
  },
  wait,
);

test(
  "the wait ends unconfirmed at its ten-minute deadline",
  async () => {
    await repository("worktree");
    const start = clock;
    // The second read happens just before the deadline, and the clock then reaches it.
    const read = preparations([null], (count) => {
      if (count === 1) setSystemTime(start + 599_999);
      if (count === 2) setSystemTime(start + 600_000);
    });
    expect(await waitForPreparation(paths(), `${root}/worktree`, since)).toMatchObject({
      tag: "Err",
      error: {
        reason: "worktree_setup_unconfirmed",
        detail:
          "The Herdr worktree hook did not record a finished preparation. Check the Operator Herdr plugin and its log.",
      },
    });
    expect(read).toHaveBeenCalledTimes(3);
  },
  wait,
);
