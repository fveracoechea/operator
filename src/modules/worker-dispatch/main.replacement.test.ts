import { afterAll, afterEach, expect, mock, setSystemTime, test } from "bun:test";
import { ErrAsync, Ok, OkAsync } from "unthrown";
import { DeviceState } from "../device-state/main.ts";
import { OperatorHome } from "../operator-home/main.ts";
import { dispatchDevice, git, removeDevices } from "./dispatch-fixture.ts";
import { WorkerDispatch } from "./main.ts";

afterEach(() => {
  mock.restore();
  setSystemTime();
});
afterAll(removeDevices);

test("launch failure context omits unknown nested facts and interruption names the next recorded action", async () => {
  await using device = await dispatchDevice();
  device.herdr.prompt.mockReturnValueOnce(
    ErrAsync({ reason: "herdr_failed" as const, detail: "no confirmation" }),
  );
  const failed = await WorkerDispatch.dispatch(device.request("read"));
  expect(failed).toMatchObject({
    tag: "Err",
    error: { reason: "launch_failed", state: { launch: "failed" } },
  });
  if (failed.tag === "Err" && "state" in failed.error)
    expect(failed.error.state).not.toHaveProperty("failure");
  device.herdr.prompt.mockImplementation(() => {
    device.exited("p1");
    return OkAsync(null);
  });
  expect(await WorkerDispatch.dispatch(device.request("read"))).toMatchObject({
    tag: "Err",
    error: {
      reason: "launch_interrupted",
      next: {
        command: "operator next",
        why: "Read the recorded launch action before starting a replacement.",
      },
      state: { launch: "interrupted" },
    },
  });
});

test("a failed start stays visible with its resources, and a replacement starts again", async () => {
  await using device = await dispatchDevice();
  device.herdr.prompt.mockReturnValueOnce(
    ErrAsync({
      reason: "herdr_failed" as const,
      detail: "herdr agent prompt exited 1: busy",
      state: { promptConfirmed: false },
    }),
  );
  expect(await WorkerDispatch.dispatch(device.request("survey"))).toMatchObject({
    tag: "Err",
    error: {
      reason: "launch_failed",
      next: {
        command: "operator next",
        why: "Read the recorded launch action before starting a replacement.",
      },
      state: { launch: "failed", failure: { promptConfirmed: false } },
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
      next: {
        decider: "person",
        question: "How should the missing PR worktree be recovered without losing unlanded work?",
      },
      state: { reusable: false },
      detail:
        "The recorded worktree of PR #7 on task/impl is missing. Ask the person how to recover it. Nothing was launched.",
    },
  });
  expect(await device.launches("impl")).toHaveLength(1);
});

/** Records report 1 of `survey` and its promotion into `build`, as `report accept --promote` does. */
function promoteSurvey(device: Awaited<ReturnType<typeof dispatchDevice>>, launchId: string) {
  const target = {
    by: "key" as const,
    repository: "example/one",
    checkout: device.checkout,
    sourceId: device.sourceId,
    assignment: "survey",
  };
  const report = {
    sourceId: device.sourceId,
    assignment: "survey",
    number: 1,
    launchId,
    submittedAt: "2026-01-01T00:00:00.000Z",
    conclusion: "Build it.",
    evidence: "[]",
    unresolved: "[]",
    decisions: "[]",
    files: "[]",
    decision: "accepted",
    decidedAt: "2026-01-01T00:00:00.000Z",
    followUp: null,
    cleanupState: "done",
    cleanupDetail: "Promoted to build.",
  };
  expect(
    DeviceState.changeReport(device.paths, target, () =>
      Ok({
        insert: report,
        assignmentState: "completed",
        promote: {
          assignment: { sourceId: device.sourceId, key: "build", completion: "pr", state: "ready" },
          promotion: {
            sourceId: device.sourceId,
            assignment: "build",
            report: "survey",
            reportNumber: 1,
            trackerKey: "github:example/one#9",
            instructions: "Build what survey found.",
            branch: "task/build",
            internalReview: false,
            worktreePath: `${device.root}/worktrees/report-one-6-survey`,
            handoverLaunchId: null,
            promotedAt: "2026-01-01T00:00:00.000Z",
          },
          launch: null,
        },
      }),
    ).tag,
  ).toBe("Ok");
}

test("a promoted assignment whose worker stopped starts in the promoted report's worktree", async () => {
  await using device = await dispatchDevice();
  const survey = await WorkerDispatch.dispatch(device.request("survey"));
  expect(survey.tag).toBe("Ok");
  const worktree = `${device.root}/worktrees/report-one-6-survey`;
  device.exited("p2");
  const [launch] = await device.launches("survey");
  promoteSurvey(device, launch?.id ?? "");
  // Promotion renamed the worktree branch before the worker stopped.
  git(worktree, "branch", "-m", "task/survey", "task/build");
  device.reopening();

  expect(await WorkerDispatch.dispatch(device.request("build"))).toMatchObject({
    tag: "Ok",
    value: { attempt: 1, name: "pr-one-9-build", branch: "task/build", worktreePath: worktree },
  });
  expect(device.herdr.openWorktree).toHaveBeenLastCalledWith({
    workspaceId: "w1",
    path: worktree,
    label: "pr-one-9-build",
  });
  expect(device.herdr.createWorktree).toHaveBeenCalledTimes(1);
  const brief = await Bun.file(
    OperatorHome.assignmentFiles(device.paths, {
      repository: "example/one",
      sourceId: device.sourceId,
      assignment: "build",
    }).brief,
  ).text();
  expect(brief).toContain("The SuperAgent promoted report 1 of `survey` into this PR assignment.");
  expect(brief).toContain("### `survey` report 1");
  expect(brief).toContain(`on branch \`task/build\``);
});

test("a promoted assignment whose worktree is gone is not started anywhere else", async () => {
  await using device = await dispatchDevice();
  expect((await WorkerDispatch.dispatch(device.request("survey"))).tag).toBe("Ok");
  device.exited("p2");
  const [launch] = await device.launches("survey");
  promoteSurvey(device, launch?.id ?? "");
  const worktree = `${device.root}/worktrees/report-one-6-survey`;
  git(device.checkout, "worktree", "remove", "--force", worktree);

  expect(await WorkerDispatch.dispatch(device.request("build"))).toMatchObject({
    tag: "Err",
    error: {
      reason: "promotion_worktree_missing",
      detail: `The worktree ${worktree} of promoted report survey is missing. Ask the person how to recover it. Nothing was launched.`,
      next: {
        decider: "person",
        question:
          "How should the missing promoted worktree be recovered without losing unlanded work?",
      },
      state: { reusable: false },
    },
  });
  expect(await device.launches("build")).toEqual([]);
  expect(device.herdr.createWorktree).toHaveBeenCalledTimes(1);
});
