import { afterEach, expect, mock, spyOn, test } from "bun:test";
// Bun has no temporary-directory or symlink API.
import { mkdtemp, realpath, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { OkAsync } from "unthrown";
import { Projects } from "../projects/main.ts";
import { DeviceState } from "../device-state/main.ts";
import { git, prDevice, repository } from "./device-fixture.ts";
import { qualify, resolveOwner } from "./owner.ts";

afterEach(() => {
  mock.restore();
});

const nothing = "Nothing was read from GitHub or changed.";

test("the recorded worktree of a running PR assignment resolves its owner from any folder", async () => {
  await using device = await prDevice();
  const { launchId, worktree } = device.start("parent");
  await Bun.write(`${worktree}/src/a.ts`, "x\n", { createPath: true });
  await symlink(worktree, `${device.root}/link`);
  for (const cwd of [worktree, `${worktree}/src`, `${device.root}/link`])
    expect<unknown>(await resolveOwner({ paths: device.paths, cwd })).toMatchObject({
      tag: "Ok",
      value: {
        launchId,
        launchState: "running",
        branch: "task/parent",
        sourceId: device.sourceId,
        assignment: "parent",
        assignmentState: "running",
        repository,
        checkout: device.checkout,
        worktreePath: worktree,
      },
    });
});

test("an associated PR keeps its owner", async () => {
  await using device = await prDevice();
  const { launchId, worktree } = device.start("parent");
  device.associate(launchId, 7, "task/parent");
  expect<unknown>(await resolveOwner({ paths: device.paths, cwd: worktree })).toMatchObject({
    tag: "Ok",
    value: { launchId, assignmentState: "pr-open", pullRequest: 7 },
  });
});

test("a folder outside Git or outside a recorded worktree selects no owner", async () => {
  await using device = await prDevice();
  device.start("parent");
  const outside = await realpath(await mkdtemp(path.join(tmpdir(), "operator-outside-")));
  expect<unknown>(await resolveOwner({ paths: device.paths, cwd: outside })).toEqual({
    tag: "Err",
    error: {
      reason: "pr_worktree_unrecorded",
      detail: `Run PR commands inside the recorded worktree of your assignment. ${nothing}`,
    },
  });
  expect<unknown>(await resolveOwner({ paths: device.paths, cwd: device.checkout })).toEqual({
    tag: "Err",
    error: {
      reason: "pr_worktree_unrecorded",
      detail: `${device.checkout} is not the recorded worktree of an assignment. ${nothing}`,
    },
  });
});

test("a running owner wins a reused worktree path, in either record order", async () => {
  for (const order of ["failed first", "running first"]) {
    await using device = await prDevice();
    const shared = `${device.root}/worktrees/shared`;
    function failedStart() {
      return device.start("other", {
        worktree: shared,
        branch: "task/parent",
        state: "failed",
        add: order === "failed first",
      });
    }
    function runningStart() {
      return device.start("parent", { worktree: shared, add: order !== "failed first" });
    }
    const first = order === "failed first" ? failedStart() : runningStart();
    const second = order === "failed first" ? runningStart() : failedStart();
    const running = order === "failed first" ? second : first;
    expect<unknown>(await resolveOwner({ paths: device.paths, cwd: shared })).toMatchObject({
      tag: "Ok",
      value: { launchId: running.launchId, assignment: "parent" },
    });
  }
});

test("a launch without a recorded worktree never matches", async () => {
  await using device = await prDevice();
  device.start("parent", { worktree: null });
  expect<unknown>(await resolveOwner({ paths: device.paths, cwd: device.checkout })).toMatchObject({
    tag: "Err",
    error: { reason: "pr_worktree_unrecorded" },
  });
});

function inactive(assignment: string) {
  return {
    tag: "Err",
    error: {
      reason: "pr_owner_inactive",
      detail: `This worktree belongs to assignment ${assignment}, which has no running PR owner. ${nothing}`,
    },
  };
}

test("only the running start of an open PR assignment with a branch owns the worktree", async () => {
  await using device = await prDevice();
  const failed = device.start("other", { state: "failed" });
  expect<unknown>(await resolveOwner({ paths: device.paths, cwd: failed.worktree })).toEqual(
    inactive("other"),
  );
  const report = device.start("read");
  expect<unknown>(await resolveOwner({ paths: device.paths, cwd: report.worktree })).toEqual(
    inactive("read"),
  );
  const detached = device.start("parent", { branch: null });
  expect<unknown>(await resolveOwner({ paths: device.paths, cwd: detached.worktree })).toEqual(
    inactive("parent"),
  );
});

test("a merged assignment has no running PR owner", async () => {
  await using device = await prDevice();
  const parent = device.start("parent");
  device.associate(parent.launchId, 7, "task/parent");
  device.merged(parent.launchId, 7, "h1");
  expect<unknown>(await resolveOwner({ paths: device.paths, cwd: parent.worktree })).toEqual(
    inactive("parent"),
  );
});

test("a running launch of an ended source has no running PR owner", async () => {
  await using device = await prDevice();
  const other = device.start("other");
  // A reset needs every worker pane closed first, so the ended source is observed directly.
  const owners = DeviceState.worktreeOwners;
  spyOn(DeviceState, "worktreeOwners").mockImplementation((paths) =>
    owners(paths).map((rows) => rows.map((row) => ({ ...row, sourceState: "abandoned" }))),
  );
  expect<unknown>(await resolveOwner({ paths: device.paths, cwd: other.worktree })).toEqual(
    inactive("other"),
  );
});

function mismatch() {
  return {
    tag: "Err",
    error: {
      reason: "pr_repository_mismatch",
      detail: `This worktree is not a worktree of the registered ${repository} checkout. ${nothing}`,
    },
  };
}

test("a recorded path that holds another repository is refused", async () => {
  await using device = await prDevice();
  const foreign = `${device.root}/worktrees/parent`;
  await Bun.write(`${foreign}/README.md`, "foreign\n", { createPath: true });
  git(foreign, "init", "-q", "-b", "task/parent");
  device.start("parent", { worktree: foreign, add: false });
  expect<unknown>(await resolveOwner({ paths: device.paths, cwd: foreign })).toEqual(mismatch());
});

test("a controlling checkout that lost its identity or names another repository is refused", async () => {
  await using device = await prDevice();
  const { worktree } = device.start("parent");
  const current = spyOn(Projects, "current");
  current.mockReturnValue(
    OkAsync({
      reason: "project_resolved" as const,
      data: { repository: "example/two", checkout: device.checkout, registeredAt: "now" },
    }),
  );
  expect<unknown>(await resolveOwner({ paths: device.paths, cwd: worktree })).toEqual(mismatch());
  current.mockRestore();
  git(device.checkout, "remote", "set-url", "origin", "https://github.com/example/two.git");
  expect<unknown>(await resolveOwner({ paths: device.paths, cwd: worktree })).toEqual(mismatch());
});

test("the worktree must be on the recorded branch", async () => {
  await using device = await prDevice();
  const { worktree } = device.start("parent");
  git(worktree, "switch", "-q", "-c", "elsewhere");
  expect<unknown>(await resolveOwner({ paths: device.paths, cwd: worktree })).toEqual({
    tag: "Err",
    error: {
      reason: "pr_branch_mismatch",
      detail: `The worktree must be on the recorded branch task/parent, not elsewhere. ${nothing}`,
    },
  });
  git(worktree, "switch", "-q", "--detach");
  expect<unknown>(await resolveOwner({ paths: device.paths, cwd: worktree })).toEqual({
    tag: "Err",
    error: {
      reason: "pr_branch_mismatch",
      detail: `The worktree must be on the recorded branch task/parent, not a detached HEAD. ${nothing}`,
    },
  });
});

test("expected file system errors become a PR I/O failure and other errors stay defects", () => {
  for (const code of ["ENOENT", "EACCES", "EPERM", "EIO", "ENOTDIR", "ELOOP"]) {
    const cause = Object.assign(new Error(`${code}: failed`), { code });
    expect(qualify(cause, () => "defect")).toEqual({
      reason: "pr_io_failed",
      detail: `Error: ${code}: failed`,
    });
  }
  expect(qualify(Object.assign(new Error("busy"), { code: "EBUSY" }), () => "defect")).toBe(
    "defect",
  );
  expect(qualify(new Error("plain"), () => "defect")).toBe("defect");
});
