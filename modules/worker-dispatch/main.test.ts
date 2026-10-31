import { afterAll, afterEach, expect, mock, setSystemTime, spyOn, test } from "bun:test";
import { ErrAsync, OkAsync, fromPromise } from "unthrown";
import { DeviceSettings } from "../device-settings/main.ts";
import { DeviceState } from "../device-state/main.ts";
import { Herdr } from "../herdr/main.ts";
import { OperatorHome } from "../operator-home/main.ts";
import { OperatorRelease } from "../operator-release/main.ts";
import { OwnedSkills } from "../owned-skills/main.ts";
import { dispatchDevice, git, removeDevices, resolved } from "./dispatch-fixture.ts";
import { WorkerDispatch } from "./main.ts";

afterEach(() => {
  mock.restore();
  setSystemTime();
});
afterAll(removeDevices);

test("read-only work gets a tab in the project workspace, a brief, and a running launch", async () => {
  await using device = await dispatchDevice();
  const { herdr, checkout } = device;
  const manifest = await OperatorRelease.manifest();
  const release = {
    version: manifest.version,
    commit: manifest.commit,
    artifactIdentity: manifest.artifactIdentity,
  };
  const skills = await OwnedSkills.identities();
  const files = OperatorHome.assignmentFiles(device.paths, {
    repository: "example/one",
    sourceId: device.sourceId,
    assignment: "read",
  });
  await Bun.write(`${files.reports}/1/report.md`, "earlier\n", { createPath: true });
  await Bun.write(`${files.followUps}/1.md`, "follow\n", { createPath: true });
  // The start is recorded before Herdr starts the agent.
  herdr.startAgent.mockImplementation(() =>
    fromPromise(
      async () => {
        const [launch] = await device.launches("read");
        expect(launch).toMatchObject({ state: "starting", tabId: "t1", paneId: "p1" });
        return null;
      },
      (cause, defect) => defect(cause),
    ),
  );
  const name = "report-one-4-read";
  const signals = ["SIGHUP", "SIGINT", "SIGTERM"] as const;
  const listeners = signals.map((signal) => process.listenerCount(signal));
  expect(await WorkerDispatch.dispatch(device.request("read"))).toMatchObject({
    tag: "Ok",
    value: {
      sourceId: device.sourceId,
      assignment: "read",
      attempt: 1,
      name,
      host: "claude-code",
      model: "claude-resolved",
      reasoningEffort: "high",
      profile: "careful",
      release,
      skills,
      brief: files.brief,
      workspaceId: "w1",
      paneId: "p1",
      worktreePath: null,
      branch: null,
      preparation: null,
    },
  });
  // The start removes its stop handlers when it ends.
  expect(signals.map((signal) => process.listenerCount(signal))).toEqual(listeners);
  expect(herdr.createWorkspace).not.toHaveBeenCalled();
  expect(herdr.tabLabels).toHaveBeenCalledWith("w1");
  expect(herdr.createTab).toHaveBeenCalledWith({ workspaceId: "w1", cwd: checkout, label: name });
  expect(herdr.createWorktree).not.toHaveBeenCalled();
  expect(herdr.renameTab).not.toHaveBeenCalled();
  expect(herdr.startAgent).toHaveBeenCalledWith({
    name,
    kind: "claude",
    paneId: "p1",
    args: resolved.command.args,
  });
  expect(herdr.prompt).toHaveBeenCalledWith({ name, text: `Read ${files.brief} and follow it.` });
  const brief = await Bun.file(files.brief).text();
  for (const text of [
    `- Source: \`${device.sourceId}\`, tracker key \`github:example/one#1\`.`,
    "- Assignment: `read`, tracker key `github:example/one#4`.",
    "a report that the SuperAgent accepts",
    "- Start profile: `careful`.",
    "Do the read work.",
    `Work in a separate pane of the controlling checkout \`${checkout}\`.`,
    `\`${files.reports}/1/report.md\``,
    `\`${files.followUps}/1.md\``,
    `Operator stores the report and copies of the supporting files in \`${files.reports}\`.`,
  ])
    expect(brief).toContain(text);
  expect(await device.launches("read")).toMatchObject([
    {
      attempt: 1,
      state: "running",
      name,
      resources: "pane",
      branch: null,
      host: "claude-code",
      model: "claude-resolved",
      reasoningEffort: "high",
      profile: "careful",
      release,
      skills,
      workspaceId: "w1",
      tabId: "t1",
      paneId: "p1",
      worktreePath: null,
      worktreeWorkspaceId: null,
      endedAt: null,
      failureReason: null,
    },
  ]);
  // The launch records this Herdr session, so its hook observations find it.
  device.exited("p1");
  expect(await device.launches("read")).toMatchObject([{ state: "interrupted" }]);
});

test("worktree work gets a new prepared worktree on its branch and an OpenCode agent", async () => {
  // The hook records its preparation after Herdr answers, so the start waits for it.
  await using device = await dispatchDevice({ deferPreparation: true });
  spyOn(DeviceSettings, "resolve").mockReturnValue(
    OkAsync({ ...resolved, host: "opencode" as const, command: { tool: "opencode", args: [] } }),
  );
  const name = "pr-one-4-impl";
  const worktree = `${device.root}/worktrees/${name}`;
  expect(await WorkerDispatch.dispatch(device.request("impl"))).toMatchObject({
    tag: "Ok",
    value: {
      name,
      host: "opencode",
      workspaceId: "w1",
      paneId: "p2",
      worktreePath: worktree,
      branch: "task/impl",
      preparation: "fresh ready",
    },
  });
  expect(device.herdr.createWorktree).toHaveBeenCalledWith({
    workspaceId: "w1",
    branch: "task/impl",
    label: name,
    base: undefined,
  });
  expect(device.herdr.renameTab).toHaveBeenCalledWith({ tabId: "t2", label: name });
  expect(device.herdr.createTab).not.toHaveBeenCalled();
  expect(device.herdr.startAgent).toHaveBeenCalledWith({
    name,
    kind: "opencode",
    paneId: "p2",
    args: [],
  });
  expect(await device.launches("impl")).toMatchObject([
    {
      state: "running",
      resources: "worktree",
      branch: "task/impl",
      workspaceId: "w1",
      tabId: "t2",
      paneId: "p2",
      worktreePath: worktree,
      worktreeWorkspaceId: "w2",
    },
  ]);
  const brief = await Bun.file(
    OperatorHome.assignmentFiles(device.paths, {
      repository: "example/one",
      sourceId: device.sourceId,
      assignment: "impl",
    }).brief,
  ).text();
  expect(brief).toContain(`worktree \`${worktree}\` on branch \`task/impl\``);
  expect(brief).toContain("Target the default branch.");
  expect(brief).toContain("`operator pr associate --json`");
});

test("a missing project workspace is created, and no tab list is read", async () => {
  await using device = await dispatchDevice();
  device.herdr.workspaces.mockReturnValue(
    OkAsync([{ workspaceId: "w9", label: "wt", checkout: device.checkout, linked: true }]),
  );
  expect(await WorkerDispatch.dispatch(device.request("read"))).toMatchObject({
    tag: "Ok",
    value: { workspaceId: "w-new" },
  });
  expect(device.herdr.tabLabels).not.toHaveBeenCalled();
  expect(device.herdr.createWorkspace).toHaveBeenCalledWith({
    cwd: device.checkout,
    label: "one",
  });
  expect(device.herdr.createTab).toHaveBeenCalledWith({
    workspaceId: "w-new",
    cwd: device.checkout,
    label: "report-one-4-read",
  });
  expect(await device.launches("read")).toMatchObject([{ workspaceId: "w-new" }]);
});

test("taken agent, tab, workspace, and branch names get the next shared suffix", async () => {
  await using device = await dispatchDevice();
  device.herdr.agentNames.mockReturnValue(OkAsync(["pr-one-4-impl"]));
  device.herdr.tabLabels.mockReturnValue(OkAsync(["pr-one-4-impl-2"]));
  device.herdr.workspaces.mockReturnValue(
    OkAsync([
      { workspaceId: "w1", label: "pr-one-4-impl-3", checkout: device.checkout, linked: false },
    ]),
  );
  git(device.checkout, "branch", "task/impl-4");
  git(device.checkout, "update-ref", "refs/remotes/origin/task/impl-5", "HEAD");
  expect(await WorkerDispatch.dispatch(device.request("impl"))).toMatchObject({
    tag: "Ok",
    value: { name: "pr-one-4-impl-6", branch: "task/impl-6" },
  });
  // An agent name never adopts the unrecorded branch either.
  expect(git(device.checkout, "rev-parse", "task/impl-4")).toBe(
    git(device.checkout, "rev-parse", "main"),
  );
});

test("a name that an earlier launch recorded is skipped", async () => {
  await using device = await dispatchDevice();
  device.herdr.startAgent.mockReturnValueOnce(
    ErrAsync({ reason: "herdr_failed" as const, detail: "no agent" }),
  );
  expect(await WorkerDispatch.dispatch(device.request("read"))).toMatchObject({ tag: "Err" });
  expect(await WorkerDispatch.dispatch(device.request("read"))).toMatchObject({
    tag: "Ok",
    value: { name: "report-one-4-read-2", attempt: 2 },
  });
});

test("no free name refuses the start before any record or Herdr effect", async () => {
  await using device = await dispatchDevice();
  device.herdr.agentNames.mockReturnValue(
    OkAsync([
      "report-one-4-read",
      ...Array.from({ length: 998 }, (_, index) => `report-one-4-read-${index + 2}`),
    ]),
  );
  expect(await WorkerDispatch.dispatch(device.request("read"))).toMatchObject({
    tag: "Err",
    error: {
      reason: "launch_name_exhausted",
      detail: "No free launch name or branch remains. Nothing was launched.",
    },
  });
  expect(device.herdr.createTab).not.toHaveBeenCalled();
  expect(await device.launches("read")).toEqual([]);
});

test("an assignment with no dispatch action or a source that is not registered is refused before any effect", async () => {
  await using device = await dispatchDevice();
  for (const request of [device.request("blocked"), device.request("missing")])
    expect(await WorkerDispatch.dispatch(request)).toMatchObject({
      tag: "Err",
      error: {
        reason: "assignment_not_dispatchable",
        detail: `Assignment ${request.assignment} has no dispatch action. Read operator next for its waits. Nothing was launched.`,
      },
    });
  expect(
    await WorkerDispatch.dispatch({ ...device.request("read"), sourceId: "unknown" }),
  ).toMatchObject({ tag: "Err", error: { reason: "source_not_found" } });
  // A running worker leaves its assignment without a dispatch action.
  expect(await WorkerDispatch.dispatch(device.request("read"))).toMatchObject({ tag: "Ok" });
  expect(await WorkerDispatch.dispatch(device.request("read"))).toMatchObject({
    tag: "Err",
    error: { reason: "assignment_not_dispatchable" },
  });
  // An idle worker needs attention, not a replacement.
  device.activity("p1", "idle");
  expect(await WorkerDispatch.dispatch(device.request("read"))).toMatchObject({
    tag: "Err",
    error: {
      reason: "assignment_not_dispatchable",
      detail:
        "Assignment read has no dispatch action. Read operator next for its waits. Nothing was launched.",
    },
  });
  expect(device.herdr.createTab).toHaveBeenCalledTimes(1);
});

test("a launch check failure refuses the start before any record", async () => {
  await using device = await dispatchDevice();
  spyOn(Herdr, "plugins").mockReturnValue(OkAsync([]));
  expect(await WorkerDispatch.dispatch(device.request("read"))).toMatchObject({
    tag: "Err",
    error: { reason: "herdr_plugin_missing" },
  });
  expect(device.herdr.agentNames).not.toHaveBeenCalled();
  expect(await device.launches("read")).toEqual([]);
});

test("the interface passes observation, plugin, reviewer, and cleanup calls to their owners", async () => {
  await using device = await dispatchDevice();
  const plugins = spyOn(Herdr, "plugins").mockReturnValue(
    ErrAsync({ reason: "herdr_unavailable" as const, detail: "gone" }),
  );
  expect(await WorkerDispatch.installPlugin({ paths: device.paths })).toMatchObject({
    tag: "Err",
    error: { reason: "herdr_unavailable" },
  });
  expect(plugins).toHaveBeenCalledTimes(1);
  expect(await WorkerDispatch.observe({ paths: device.paths })).toMatchObject({
    tag: "Err",
    error: { reason: "herdr_event_invalid" },
  });
  expect(
    await WorkerDispatch.cleanWorktree({
      paths: device.paths,
      checkout: device.checkout,
      worktree: `${device.root}/gone`,
      branch: null,
    }),
  ).toEqual({ state: "absent", detail: `Worktree ${device.root}/gone no longer exists.` });
  expect(
    await WorkerDispatch.moveReviewer({
      checkout: device.checkout,
      repository: "example/two",
      number: 7,
      worktree: `${device.root}/gone`,
      from: "a",
      to: "b",
    }),
  ).toMatchObject({ tag: "Err", error: { reason: "review_fetch_failed" } });
  const failure = { reason: "herdr_plugin_missing", detail: "x" };
  plugins.mockReturnValue(OkAsync([]));
  expect(
    await WorkerDispatch.launchReviewer({
      paths: device.paths,
      checkout: device.checkout,
      repository: "example/one",
      number: 7,
      head: "abc",
      exactHead: true,
      nameBase: "review",
      branchBase: "review/7",
      profile: undefined,
      reuse: null,
      brief: { file: `${device.root}/brief.md`, render: () => "" },
      record: () => DeviceState.launchNames(device.paths),
    }),
  ).toMatchObject({ tag: "Err", error: { reason: failure.reason } });
});
