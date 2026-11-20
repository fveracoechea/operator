import { afterEach, expect, mock, spyOn, test } from "bun:test";
// Bun has no temporary-directory or symlink API.
import { mkdtemp, realpath, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { OkAsync } from "unthrown";
import { Projects } from "../projects/main.ts";
import { DeviceState } from "../device-state/main.ts";
import { git, prDevice, repository } from "./device-fixture.ts";
import { isImplementer, qualify, resolveOwner } from "./owner.ts";
import { WorkerKinds } from "../worker-kinds/main.ts";

afterEach(() => {
  mock.restore();
});

const nothing = "Nothing was read from GitHub or changed.";

test("a directly adopted reviewer is not an outgoing implementer, while implementation and legacy ownership stay fenced", () => {
  const owner = { implementerLaunchId: "incoming", launchId: "incoming", kind: null };
  expect(isImplementer(owner)).toBe(true);
  expect(
    isImplementer({ ...owner, kind: JSON.stringify(WorkerKinds.resolve("implementation")) }),
  ).toBe(true);
  expect(isImplementer({ ...owner, kind: JSON.stringify(WorkerKinds.resolve("review")) })).toBe(
    false,
  );
  expect(isImplementer({ ...owner, launchId: "later" })).toBe(false);
});

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

test("a ready adopted owner carries a validated readiness receipt rather than storage text", async () => {
  await using device = await prDevice();
  const { launchId, worktree } = device.start("parent", {
    kind: JSON.stringify(WorkerKinds.resolve("pr-feedback")),
  });
  const readiness = DeviceState.prReadinessSchema().parse({
    head: "historical-head",
    at: "historical-time",
    note: null,
    dispositions: [{ round: 1, finding: 1, disposition: "applied" }],
  });
  expect(
    DeviceState.adoptPullRequest(
      device.paths,
      launchId,
      {
        number: 7,
        url: `https://github.com/${repository}/pull/7`,
        branch: "task/parent",
        relay: null,
        readiness,
      },
      { internalReview: false, assignmentReview: false },
    ).tag,
  ).toBe("Ok");
  const owner = await resolveOwner({ paths: device.paths, cwd: worktree });
  expect(owner.tag).toBe("Ok");
  if (owner.tag !== "Ok") return;
  expect(owner.value.readiness).toEqual(readiness);
  expect(owner.value.readiness?.head).toBe("historical-head");
  expect(owner.value.readiness?.dispositions[0]?.disposition).toBe("applied");
  expect(owner.value.outgoingLaunchId).toBeNull();
  expect(device.calls).toEqual([]);
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
      next: {
        command: "operator next",
        why: "Locate the assignment's recorded worktree before running a PR command.",
      },
      state: { gitTopLevel: null },
    },
  });
  expect<unknown>(await resolveOwner({ paths: device.paths, cwd: device.checkout })).toEqual({
    tag: "Err",
    error: {
      reason: "pr_worktree_unrecorded",
      detail: `${device.checkout} is not the recorded worktree of an assignment. ${nothing}`,
      next: {
        command: "operator next",
        why: "Locate the assignment's recorded worktree before running a PR command.",
      },
      state: { worktree: device.checkout, recorded: false },
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

test.each(["same path", "symlink alias"])(
  "two running owners refuse an ambiguous real worktree with the original first: %s",
  async (identity) => {
    await using device = await prDevice();
    const original = device.start("parent");
    const alias = `${device.root}/alias`;
    await symlink(original.worktree, alias);
    const other = device.start("other", {
      worktree: identity === "same path" ? original.worktree : alias,
      branch: "task/parent",
      add: false,
    });
    const owners = DeviceState.worktreeOwners(device.paths);
    expect(owners.tag === "Ok" ? owners.value.map((owner) => owner.launchId) : []).toEqual([
      original.launchId,
      other.launchId,
    ]);
    expect<unknown>(await resolveOwner({ paths: device.paths, cwd: original.worktree })).toEqual({
      tag: "Err",
      error: {
        reason: "pr_worktree_unrecorded",
        detail: `${original.worktree} has multiple running recorded owners. Resolve the ambiguous worktree ownership before running a PR command. ${nothing}`,
        next: {
          decider: "super-agent",
          question: "Which recorded assignment should own this worktree?",
        },
        state: {
          worktree: original.worktree,
          ambiguous: true,
          launchIds: [original.launchId, other.launchId],
        },
      },
    });
    expect(device.calls).toEqual([]);
  },
);

test("a launch without a recorded worktree never matches", async () => {
  await using device = await prDevice();
  device.start("parent", { worktree: null });
  expect<unknown>(await resolveOwner({ paths: device.paths, cwd: device.checkout })).toMatchObject({
    tag: "Err",
    error: { reason: "pr_worktree_unrecorded" },
  });
});

function inactive(assignment: string, state: Record<string, unknown> = {}) {
  return {
    tag: "Err",
    error: {
      reason: "pr_owner_inactive",
      next: {
        decider: "super-agent",
        question: "Which recorded owner should continue this PR assignment?",
      },
      state: {
        source: "open",
        assignment: "running",
        completion: "pr",
        launch: "running",
        branch: `task/${assignment}`,
        ...state,
      },
      detail: `This worktree belongs to assignment ${assignment}, which has no running PR owner. ${nothing}`,
    },
  };
}

test("only the running start of an open PR assignment with a branch owns the worktree", async () => {
  await using device = await prDevice();
  const failed = device.start("other", { state: "failed" });
  expect<unknown>(await resolveOwner({ paths: device.paths, cwd: failed.worktree })).toEqual(
    inactive("other", { launch: "failed" }),
  );
  const report = device.start("read");
  expect<unknown>(await resolveOwner({ paths: device.paths, cwd: report.worktree })).toEqual(
    inactive("read", { completion: "report" }),
  );
  const detached = device.start("parent", { branch: null });
  expect<unknown>(await resolveOwner({ paths: device.paths, cwd: detached.worktree })).toEqual(
    inactive("parent", { branch: null }),
  );
});

test("a merged assignment has no running PR owner", async () => {
  await using device = await prDevice();
  const parent = device.start("parent");
  device.associate(parent.launchId, 7, "task/parent");
  device.merged(parent.launchId, 7, "h1");
  expect<unknown>(await resolveOwner({ paths: device.paths, cwd: parent.worktree })).toEqual(
    inactive("parent", { assignment: "merged" }),
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
    inactive("other", { source: "abandoned" }),
  );
});

function mismatch() {
  return {
    tag: "Err",
    error: {
      reason: "pr_repository_mismatch",
      next: {
        decider: "super-agent",
        question:
          "How should this worktree's repository mismatch be resolved while preserving its work?",
      },
      state: { repository, matches: false },
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
      next: {
        decider: "super-agent",
        question: "How should the recorded PR branch be restored without losing local work?",
      },
      state: { expected: "task/parent", actual: "elsewhere" },
    },
  });
  git(worktree, "switch", "-q", "--detach");
  expect<unknown>(await resolveOwner({ paths: device.paths, cwd: worktree })).toEqual({
    tag: "Err",
    error: {
      reason: "pr_branch_mismatch",
      detail: `The worktree must be on the recorded branch task/parent, not a detached HEAD. ${nothing}`,
      next: {
        decider: "super-agent",
        question: "How should the recorded PR branch be restored without losing local work?",
      },
      state: { expected: "task/parent", actual: null },
    },
  });
});

test("expected file system errors become a PR I/O failure and other errors stay defects", () => {
  for (const code of ["ENOENT", "EACCES", "EPERM", "EIO", "ENOTDIR", "ELOOP"]) {
    const cause = Object.assign(new Error(`${code}: failed`), { code });
    expect(qualify(cause, () => "defect")).toEqual({
      reason: "pr_io_failed",
      next: {
        decider: "super-agent",
        question: "How should the PR worktree IO failure be corrected without losing work?",
      },
      state: { code },
      detail: `Error: ${code}: failed`,
    });
  }
  expect(qualify(Object.assign(new Error("busy"), { code: "EBUSY" }), () => "defect")).toBe(
    "defect",
  );
  expect(qualify(new Error("plain"), () => "defect")).toBe("defect");
});
