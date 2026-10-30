import { afterAll, afterEach, expect, mock, setSystemTime, test } from "bun:test";
import { ErrAsync } from "unthrown";
import { OperatorHome } from "../operator-home/main.ts";
import { dispatchDevice, git, removeDevices } from "./dispatch-fixture.ts";
import { WorkerDispatch } from "./main.ts";

afterEach(() => {
  mock.restore();
  setSystemTime();
});
afterAll(removeDevices);

test("a failed start stays visible with its resources, and a replacement starts again", async () => {
  await using device = await dispatchDevice();
  device.herdr.prompt.mockReturnValueOnce(
    ErrAsync({ reason: "herdr_failed" as const, detail: "herdr agent prompt exited 1: busy" }),
  );
  expect(await WorkerDispatch.dispatch(device.request("survey"))).toMatchObject({
    tag: "Err",
    error: {
      reason: "launch_failed",
      detail:
        "herdr_failed: herdr agent prompt exited 1: busy The launch is recorded as failed. Read operator next before a replacement.",
    },
  });
  const worktree = `${device.root}/worktrees/report-one-6-survey`;
  expect(await device.launches("survey")).toMatchObject([
    {
      state: "failed",
      failureReason: "herdr_failed",
      failureDetail: "herdr agent prompt exited 1: busy",
      tabId: "t2",
      paneId: "p2",
      worktreePath: worktree,
      worktreeWorkspaceId: "w2",
    },
  ]);
  // Another assignment never reuses this worktree.
  expect(await WorkerDispatch.dispatch(device.request("impl"))).toMatchObject({
    tag: "Ok",
    value: { worktreePath: `${device.root}/worktrees/pr-one-4-impl` },
  });
  // The replacement reopens the recorded worktree on its branch, so a taken branch name with
  // the next suffix does not move its name.
  git(device.checkout, "branch", "task/survey-2");
  device.reopening();
  expect(await WorkerDispatch.dispatch(device.request("survey"))).toMatchObject({
    tag: "Ok",
    value: {
      attempt: 2,
      name: "report-one-6-survey-2",
      branch: "task/survey",
      worktreePath: worktree,
      paneId: "p3",
      preparation: "fresh ready",
    },
  });
  expect(device.herdr.openWorktree).toHaveBeenCalledWith({
    workspaceId: "w1",
    path: worktree,
    label: "report-one-6-survey-2",
  });
  expect(device.herdr.renameTab).toHaveBeenLastCalledWith({
    tabId: "t3",
    label: "report-one-6-survey-2",
  });
  expect(device.herdr.createWorktree).toHaveBeenCalledTimes(2);
  expect((await device.launches("survey"))[1]).toMatchObject({
    branch: "task/survey",
    worktreePath: worktree,
    worktreeWorkspaceId: "w3",
    tabId: "t3",
  });
});

test("a replacement whose recorded worktree is gone gets a new worktree", async () => {
  await using device = await dispatchDevice();
  device.herdr.startAgent.mockReturnValueOnce(
    ErrAsync({ reason: "herdr_failed" as const, detail: "no agent" }),
  );
  await WorkerDispatch.dispatch(device.request("survey"));
  const worktree = `${device.root}/worktrees/report-one-6-survey`;
  git(device.checkout, "worktree", "remove", "--force", worktree);
  expect(await WorkerDispatch.dispatch(device.request("survey"))).toMatchObject({
    tag: "Ok",
    value: { branch: "task/survey-2", worktreePath: `${worktree}-2` },
  });
  expect(device.herdr.openWorktree).not.toHaveBeenCalled();
});

test("a PR owner's replacement continues on the PR worktree and gets its open PR", async () => {
  await using device = await dispatchDevice();
  expect(await WorkerDispatch.dispatch(device.request("impl"))).toMatchObject({ tag: "Ok" });
  const [first] = await device.launches("impl");
  device.associate(first?.id ?? "", 7, "task/impl");
  device.exited("p2");
  // A later start that failed before Herdr placed it recorded no worktree.
  device.herdr.openWorktree.mockReturnValueOnce(
    ErrAsync({ reason: "herdr_failed" as const, detail: "no open" }),
  );
  expect(await WorkerDispatch.dispatch(device.request("impl"))).toMatchObject({
    tag: "Err",
    error: { reason: "launch_failed" },
  });
  expect((await device.launches("impl"))[1]).toMatchObject({
    branch: "task/impl",
    worktreePath: null,
  });
  const worktree = `${device.root}/worktrees/pr-one-4-impl`;
  device.reopening();
  expect(await WorkerDispatch.dispatch(device.request("impl"))).toMatchObject({
    tag: "Ok",
    value: { attempt: 3, branch: "task/impl", worktreePath: worktree, name: "pr-one-4-impl-3" },
  });
  const brief = await Bun.file(
    OperatorHome.assignmentFiles(device.paths, {
      repository: "example/one",
      sourceId: device.sourceId,
      assignment: "impl",
    }).brief,
  ).text();
  expect(brief).toContain(
    "PR #7 is already open for this assignment: https://github.com/example/one/pull/7.",
  );
  expect(device.herdr.createWorktree).toHaveBeenCalledTimes(1);
});

test("a PR on a branch that no recorded worktree holds is refused before any record", async () => {
  await using device = await dispatchDevice();
  await WorkerDispatch.dispatch(device.request("impl"));
  const [first] = await device.launches("impl");
  device.associate(first?.id ?? "", 7, "task/renamed");
  device.exited("p2");
  expect(await WorkerDispatch.dispatch(device.request("impl"))).toMatchObject({
    tag: "Err",
    error: { reason: "pr_worktree_missing" },
  });
  expect(device.herdr.openWorktree).not.toHaveBeenCalled();
});

test("a PR owner whose PR worktree is gone is refused before any record", async () => {
  await using device = await dispatchDevice();
  await WorkerDispatch.dispatch(device.request("impl"));
  const [first] = await device.launches("impl");
  device.associate(first?.id ?? "", 7, "task/impl");
  device.exited("p2");
  git(device.checkout, "worktree", "remove", "--force", `${device.root}/worktrees/pr-one-4-impl`);
  expect(await WorkerDispatch.dispatch(device.request("impl"))).toMatchObject({
    tag: "Err",
    error: {
      reason: "pr_worktree_missing",
      detail:
        "The recorded worktree of PR #7 on task/impl is missing. Ask the person how to recover it. Nothing was launched.",
    },
  });
  expect(await device.launches("impl")).toHaveLength(1);
});
