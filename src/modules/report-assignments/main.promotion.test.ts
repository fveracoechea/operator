import { afterEach, beforeEach, expect, mock, setSystemTime, spyOn, test } from "bun:test";
// Bun has no recursive removal API.
import { rm } from "node:fs/promises";
import { ErrAsync, OkAsync } from "unthrown";
import { DeviceState } from "../device-state/main.ts";
import { Herdr } from "../herdr/main.ts";
import { WorkSources } from "../work-sources/main.ts";
import { WorkerQuestions } from "../worker-questions/main.ts";
import { ReportAssignments } from "./main.ts";
import { okValue, reportDevice, socket, superPane, workerPane } from "./report-fixture.ts";

let device: Awaited<ReturnType<typeof reportDevice>>;
beforeEach(async () => {
  device = await reportDevice();
});
afterEach(async () => {
  mock.restore();
  setSystemTime();
  await rm(device.root, { recursive: true, force: true });
});

const draft = { conclusion: "Build it.", evidence: ["a.ts:1"], unresolved: ["Scope of b.ts."] };
const planned = {
  key: "build",
  trackerKey: "github:example/one#9",
  instructions: "Build what the report found.",
  branch: "task/build",
};

async function git(args: string[], cwd = device.checkout) {
  const child = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  expect(await child.exited).toBe(0);
  return (await new Response(child.stdout).text()).trim();
}

/** A worker in pane `w1:p1` submits report 1 of `read` from its own worktree. */
async function submitted(keys?: string[]) {
  await git([
    "-c",
    "user.name=t",
    "-c",
    "user.email=t@t",
    "commit",
    "-q",
    "--allow-empty",
    "-m",
    "0",
  ]);
  const worktree = `${device.root}/worktrees/read`;
  await git(["worktree", "add", "-q", "-b", "report/read", worktree]);
  const sourceId = await device.source(keys, true);
  const launch = await device.launch(sourceId, "read", {
    worktreePath: worktree,
    branch: "report/read",
  });
  const file = await device.writeJson("report.json", draft);
  const pane = device.inPane(workerPane);
  okValue(await ReportAssignments.submit({ paths: device.paths, file }));
  pane.mockRestore();
  return { sourceId, launch, worktree };
}

async function promote(sourceId: string, value: Record<string, unknown> = planned) {
  const file = await device.writeJson("promotion.json", value);
  return ReportAssignments.promote({
    paths: device.paths,
    cwd: device.checkout,
    sourceId,
    assignment: "read",
    file,
  });
}

/** A controlled Herdr that lists these agents and accepts every rename. */
function herdr(agents: string[]) {
  return {
    names: spyOn(Herdr, "agentNames").mockReturnValue(OkAsync(agents)),
    agent: spyOn(Herdr, "renameAgent").mockReturnValue(OkAsync(undefined)),
    tab: spyOn(Herdr, "renameTab").mockReturnValue(OkAsync(undefined)),
    close: spyOn(Herdr, "closePane").mockReturnValue(OkAsync("closed" as const)),
    prompt: spyOn(Herdr, "prompt").mockReturnValue(OkAsync(null)),
  };
}

async function next(sourceId: string) {
  const answer = okValue(
    await WorkSources.next({ paths: device.paths, cwd: device.checkout, sourceId }),
  );
  return answer.sources[0] ?? expect.unreachable("The source is missing.");
}

test("promotion hands a running worker, its pane, and its worktree to a new PR assignment", async () => {
  const { sourceId, launch, worktree } = await submitted();
  device.inPane(superPane);
  const called = herdr(["other", launch.name]);
  const brief = device.assignmentFiles(sourceId, "build").brief;
  const { reports } = device.assignmentFiles(sourceId);

  const result = okValue(await promote(sourceId));
  const { sentAt, rungAt } = result.data.message ?? expect.unreachable("The message is missing.");
  expect(rungAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  expect(result).toEqual({
    reason: "report_promoted",
    data: {
      sourceId,
      assignment: "read",
      state: "completed",
      report: 1,
      conclusion: draft.conclusion,
      unresolved: draft.unresolved,
      file: `${reports}/1/report.md`,
      reference: `operator:example/one/sources/${sourceId}/assignments/read/reports/1`,
      promoted: {
        assignment: "build",
        state: "running",
        branch: "task/build",
        worktreePath: worktree,
        name: "pr-one-9-build",
        brief,
      },
      message: {
        sourceId,
        assignment: "build",
        key: "promoted",
        state: "pending",
        message: `The SuperAgent promoted your report into the PR assignment build, which you now own. Read your new brief at ${brief} and follow it.`,
        questionKey: null,
        sentAt,
        rungAt,
        doorbellFailure: null,
        acknowledgedAt: null,
        reply: null,
      },
      next: "wait",
    },
  });
  // The only typed text is the doorbell of the recorded message, in the kept worker's pane.
  expect(called.prompt.mock.calls).toEqual([
    [{ name: "pr-one-9-build", text: "Operator recorded steering message promoted for you." }],
  ]);
  // The pane stays open and takes the PR launch's name. The branch takes the PR branch.
  expect(called.close).not.toHaveBeenCalled();
  expect(called.agent.mock.calls).toEqual([[{ paneId: workerPane, name: "pr-one-9-build" }]]);
  expect(called.tab.mock.calls).toEqual([[{ tabId: "w1:t1", label: "pr-one-9-build" }]]);
  expect(await git(["symbolic-ref", "--short", "HEAD"], worktree)).toBe("task/build");
  const shown = await device.show(sourceId);
  expect(shown.state).toBe("open");
  expect(shown.plan.assignments.map((row) => row.key)).toEqual(["read", "later"]);
  expect(shown.assignments).toEqual([
    { key: "read", completion: "report", state: "completed" },
    { key: "later", completion: "report", state: "ready" },
    { key: "build", completion: "pr", state: "running" },
  ]);
  expect(shown.reports).toMatchObject([
    {
      decision: "accepted",
      cleanupState: "done",
      cleanupDetail: "Promoted to build, which keeps the pane and the worktree.",
    },
  ]);
  const taken = shown.launches.find((row) => row.assignment === "build");
  expect(shown.launches.find((row) => row.assignment === "read")).toMatchObject({
    state: "finished",
  });
  expect(taken).toMatchObject({
    attempt: 1,
    state: "running",
    name: "pr-one-9-build",
    resources: "worktree",
    branch: "task/build",
    paneId: workerPane,
    worktreePath: worktree,
    activity: null,
  });
  expect(shown.planned.at(-1)).toMatchObject({
    key: "build",
    dependencies: ["read"],
    promotion: { report: "read", reportNumber: 1, handoverLaunchId: taken?.id },
  });
  // The rewritten brief is the PR template with the promotion and the accepted report.
  const text = await Bun.file(brief).text();
  expect(text).toContain("- Completion type: a merged pull request.");
  expect(text).toContain(`on branch \`task/build\``);
  expect(text).toContain("The SuperAgent promoted report 1 of `read` into this PR assignment.");
  expect(text).toContain("### `read` report 1");
  expect(text).toContain("## PR feedback loop");
  expect(await next(sourceId)).toMatchObject({
    actions: [{ assignment: "later", action: "ready_assignment" }],
    waits: [{ assignment: "build", reason: "assignment_active" }],
  });
  // The worker's PR commands find the PR launch through its pane. A report command finds none.
  device.inPane(workerPane);
  expect(
    okValue(
      await WorkerQuestions.acknowledge({ paths: device.paths, key: "promoted", file: null }),
    ),
  ).toMatchObject({ reason: "message_acknowledged", data: { state: "acknowledged" } });
  expect(await ReportAssignments.resume({ paths: device.paths })).toMatchObject({
    error: { reason: "assignment_not_report" },
  });
  // Herdr sees the worker again, so it is an ordinary running PR assignment.
  okValue(
    DeviceState.observePane(device.paths, {
      socket,
      paneId: workerPane,
      workspaceId: "w1",
      observation: { exited: false, activity: "working" },
    }),
  );
  expect(await next(sourceId)).toMatchObject({
    waits: [{ assignment: "build", reason: "assignment_active" }],
  });
});

test("promotion of a stopped worker leaves the PR assignment ready to start in its worktree", async () => {
  const { sourceId, launch, worktree } = await submitted(["read"]);
  // Herdr reports that the worker's pane closed.
  okValue(
    DeviceState.observePane(device.paths, {
      socket,
      paneId: launch.paneId ?? "",
      workspaceId: "w1",
      observation: { exited: true },
    }),
  );
  device.inPane(superPane);
  const called = herdr([]);

  expect(okValue(await promote(sourceId)).data).toMatchObject({
    promoted: { assignment: "build", state: "ready", name: null, brief: null },
    next: "dispatch",
  });
  expect(called.names).not.toHaveBeenCalled();
  expect(called.agent).not.toHaveBeenCalled();
  expect(await git(["symbolic-ref", "--short", "HEAD"], worktree)).toBe("task/build");
  const shown = await device.show(sourceId);
  // The only other assignment is complete, but the promoted one keeps the source open.
  expect(shown.state).toBe("open");
  expect(shown.launches.map((row) => row.assignment)).toEqual(["read"]);
  expect(await next(sourceId)).toMatchObject({
    actions: [{ assignment: "build", action: "ready_assignment" }],
  });
  // Reset abandons the promoted assignment like any other, and prune deletes its record.
  expect(
    okValue(
      await WorkSources.reset({
        paths: device.paths,
        cwd: device.checkout,
        sourceId,
        personInstructed: true,
      }),
    ),
  ).toMatchObject({ preserved: ["read"], abandoned: ["build"] });
  setSystemTime(Date.now() + 15 * 24 * 60 * 60 * 1000);
  expect(
    okValue(await WorkSources.prune({ paths: device.paths, cwd: device.checkout })).pruned,
  ).toMatchObject([{ id: sourceId }]);
});

test("a worker that Herdr no longer lists is not handed over", async () => {
  const { sourceId } = await submitted();
  device.inPane(superPane);
  const called = herdr(["other"]);
  expect(okValue(await promote(sourceId)).data).toMatchObject({
    promoted: { state: "ready", name: null },
    next: "dispatch",
  });
  expect(called.agent).not.toHaveBeenCalled();
  expect((await device.show(sourceId)).launches).toMatchObject([
    { assignment: "read", state: "finished" },
  ]);
});

test("a taken branch or launch name gets the next free suffix", async () => {
  const { sourceId, launch, worktree } = await submitted();
  await git(["branch", "task/build"]);
  device.inPane(superPane);
  const called = herdr([launch.name, "pr-one-9-build"]);
  expect(okValue(await promote(sourceId)).data).toMatchObject({
    promoted: { branch: "task/build-2", name: "pr-one-9-build-2" },
  });
  expect(called.agent.mock.calls).toEqual([[{ paneId: workerPane, name: "pr-one-9-build-2" }]]);
  expect(await git(["symbolic-ref", "--short", "HEAD"], worktree)).toBe("task/build-2");
});

test("promotion refuses read-only report work, which has no worktree to reuse", async () => {
  const pane = await device.source(["pane"]);
  await device.launch(pane, "pane", { paneId: "w1:p9" });
  device.inPane("w1:p9");
  okValue(
    await ReportAssignments.submit({
      paths: device.paths,
      file: await device.writeJson("pane.json", draft),
    }),
  );
  device.inPane(superPane);
  const file = await device.writeJson("promotion.json", planned);
  expect(
    await ReportAssignments.promote({
      paths: device.paths,
      cwd: device.checkout,
      sourceId: pane,
      assignment: "pane",
      file,
    }),
  ).toMatchObject({ tag: "Err", error: { reason: "promotion_worktree_missing" } });
  expect((await device.show(pane)).reports).toMatchObject([{ decision: null }]);
});

test("promotion refuses a decided report, a taken key, invalid input, and another server", async () => {
  const { sourceId, launch, worktree } = await submitted();
  device.inPane(superPane);
  herdr([launch.name]);
  expect(await promote(sourceId, { ...planned, key: "later" })).toMatchObject({
    error: { reason: "promotion_key_taken" },
  });
  // A promotion takes no completion, resources, or dependencies. They follow from it.
  expect(await promote(sourceId, { ...planned, completion: "pr" })).toMatchObject({
    error: { reason: "invalid_source_plan" },
  });
  device.inPane(superPane, "/other.sock");
  expect(await promote(sourceId)).toMatchObject({ error: { reason: "promotion_herdr_server" } });
  // Nothing changed for any refusal.
  expect(await git(["symbolic-ref", "--short", "HEAD"], worktree)).toBe("report/read");
  expect((await device.show(sourceId)).assignments).toHaveLength(2);
  device.inPane(superPane);
  okValue(await promote(sourceId));
  expect(await promote(sourceId, { ...planned, key: "again" })).toMatchObject({
    error: { reason: "report_not_submitted" },
  });
  expect(
    await ReportAssignments.accept({
      paths: device.paths,
      cwd: device.checkout,
      sourceId,
      assignment: "read",
    }),
  ).toMatchObject({ error: { reason: "report_not_submitted" } });
});

test("a removed worktree refuses the promotion before any rename", async () => {
  const { sourceId, launch, worktree } = await submitted();
  await rm(worktree, { recursive: true });
  device.inPane(superPane);
  const called = herdr([launch.name]);
  expect(await promote(sourceId)).toMatchObject({
    error: {
      reason: "promotion_worktree_missing",
      next: {
        decider: "person",
        question:
          "How should the missing report worktree be recovered without losing unlanded work?",
      },
      state: { worktree, exists: false },
    },
  });
  expect(called.agent).not.toHaveBeenCalled();
  expect((await device.show(sourceId)).reports).toMatchObject([{ decision: null }]);
});

test("a promotion that the database refuses restores each rename", async () => {
  const { sourceId, launch, worktree } = await submitted();
  device.inPane(superPane);
  const called = herdr([launch.name]);
  const change = DeviceState.changeReport;
  spyOn(DeviceState, "changeReport").mockImplementation((paths, target, decide) =>
    change(paths, target, (facts) =>
      decide({ ...facts, reports: facts.reports.map((row) => ({ ...row, number: 5 })) }),
    ),
  );
  expect(await promote(sourceId)).toMatchObject({ error: { reason: "report_changed" } });
  expect(called.agent.mock.calls).toEqual([
    [{ paneId: workerPane, name: "pr-one-9-build" }],
    [{ paneId: workerPane, name: launch.name }],
  ]);
  expect(called.tab.mock.calls.at(-1)).toEqual([{ tabId: "w1:t1", label: launch.name }]);
  expect(await git(["symbolic-ref", "--short", "HEAD"], worktree)).toBe("report/read");
  expect((await device.show(sourceId)).assignments).toHaveLength(2);
});

test("a refused Herdr rename restores the branch and records nothing", async () => {
  const { sourceId, launch, worktree } = await submitted();
  device.inPane(superPane);
  herdr([launch.name]);
  spyOn(Herdr, "renameAgent").mockReturnValue(
    ErrAsync({ reason: "herdr_failed" as const, detail: "herdr agent rename exited 1" }),
  );
  expect(await promote(sourceId)).toMatchObject({ error: { reason: "herdr_failed" } });
  expect(await git(["symbolic-ref", "--short", "HEAD"], worktree)).toBe("report/read");
  expect((await device.show(sourceId)).reports).toMatchObject([{ decision: null }]);
});

test("a refused tab rename restores the agent name and the branch and records nothing", async () => {
  const { sourceId, launch, worktree } = await submitted();
  device.inPane(superPane);
  const called = herdr([launch.name]);
  called.tab.mockReturnValue(
    ErrAsync({ reason: "herdr_failed" as const, detail: "herdr tab rename exited 1" }),
  );
  expect(await promote(sourceId)).toMatchObject({ error: { reason: "herdr_failed" } });
  expect(called.agent.mock.calls.at(-1)).toEqual([{ paneId: workerPane, name: launch.name }]);
  expect(await git(["symbolic-ref", "--short", "HEAD"], worktree)).toBe("report/read");
  expect((await device.show(sourceId)).reports).toMatchObject([{ decision: null }]);
});

test("a refused promotion names each rename that it could not restore", async () => {
  const { sourceId, launch, worktree } = await submitted();
  device.inPane(superPane);
  const called = herdr([launch.name]);
  called.agent.mockImplementation(({ name }) =>
    name === launch.name
      ? ErrAsync({ reason: "herdr_failed" as const, detail: "herdr agent rename exited 1" })
      : OkAsync(undefined),
  );
  const change = DeviceState.changeReport;
  spyOn(DeviceState, "changeReport").mockImplementation((paths, target, decide) =>
    change(paths, target, (facts) =>
      decide({ ...facts, reports: facts.reports.map((row) => ({ ...row, number: 5 })) }),
    ),
  );
  expect(await promote(sourceId)).toMatchObject({
    error: {
      reason: "promotion_undo_failed",
      detail: `The promotion was not recorded (report_changed), and these renames stayed: Herdr agent pr-one-9-build in pane w1:p1 was not renamed back to ${launch.name}. Restore them, then promote again.`,
    },
  });
  // The steps after a failed one still run.
  expect(called.tab.mock.calls.at(-1)).toEqual([{ tabId: "w1:t1", label: launch.name }]);
  expect(await git(["symbolic-ref", "--short", "HEAD"], worktree)).toBe("report/read");
  expect((await device.show(sourceId)).assignments).toHaveLength(2);
});

test("a refused Herdr rename names the branch that it could not restore", async () => {
  const { sourceId, launch, worktree } = await submitted();
  device.inPane(superPane);
  const called = herdr([launch.name]);
  // Another branch takes the report's name before the undo, so the branch cannot go back.
  called.agent.mockImplementation(() => {
    Bun.spawnSync(["git", "-C", worktree, "branch", "report/read"]);
    return ErrAsync({ reason: "herdr_failed" as const, detail: "herdr agent rename exited 1" });
  });
  expect(await promote(sourceId)).toMatchObject({
    error: {
      reason: "promotion_undo_failed",
      detail:
        "The promotion was not recorded (herdr_failed), and these renames stayed: Branch task/build was not renamed back to report/read. Restore them, then promote again.",
    },
  });
  expect(await git(["symbolic-ref", "--short", "HEAD"], worktree)).toBe("task/build");
  expect((await device.show(sourceId)).reports).toMatchObject([{ decision: null }]);
});
