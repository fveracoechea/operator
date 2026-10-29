import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
// Bun has no recursive removal, folder creation, or folder listing API.
import { mkdir, readdir, rm } from "node:fs/promises";
import { Err, ErrAsync, fromPromise, OkAsync } from "unthrown";
import { DeviceState } from "../device-state/main.ts";
import { Herdr } from "../herdr/main.ts";
import { WorkSources } from "../work-sources/main.ts";
import { WorkerDispatch } from "../worker-dispatch/main.ts";
import { ReportAssignments } from "./main.ts";
import { okValue, reportDevice, socket, superPane, workerPane } from "./report-fixture.ts";

let device: Awaited<ReturnType<typeof reportDevice>>;
beforeEach(async () => {
  device = await reportDevice();
});
afterEach(async () => {
  mock.restore();
  await rm(device.root, { recursive: true, force: true });
});

const draft = {
  conclusion: "The module has two gaps.",
  evidence: ["modules/a.ts:10 reads no state."],
  unresolved: ["Whether the scope includes b.ts."],
  decisions: [
    { question: "Which name?", answer: "Use reader.", by: "super-agent" as const },
    { question: "Is b.ts in scope?", answer: "No.", by: "person" as const },
  ],
};

/** The sorted names in a folder, or null when the folder does not exist. */
function listing(directory: string) {
  return readdir(directory).then(
    (names) => names.toSorted(),
    () => null,
  );
}

/** A worker in pane `w1:p1` submits report 1 of `read`. */
async function submitted(keys?: string[]) {
  const sourceId = await device.source(keys);
  const launch = await device.launch(sourceId);
  const file = await device.writeJson("report.json", draft);
  const pane = device.inPane(workerPane);
  okValue(await ReportAssignments.submit({ paths: device.paths, file }));
  pane.mockRestore();
  return { sourceId, launch, file };
}

/** The SuperAgent returns report 1 of `read` with this follow-up. */
async function returned(sourceId: string, text = "Read b.ts too.") {
  const file = `${device.root}/drafts/follow-up.md`;
  await Bun.write(file, text);
  device.inPane(superPane);
  const result = await ReportAssignments.return({
    paths: device.paths,
    cwd: device.checkout,
    sourceId,
    assignment: "read",
    file,
  });
  mock.restore();
  return result;
}

function accept(sourceId: string, assignment = "read") {
  return ReportAssignments.accept({
    paths: device.paths,
    cwd: device.checkout,
    sourceId,
    assignment,
  });
}

/** The controlled Herdr lists these agents and closes any pane. */
function herdr(agents: string[]) {
  return {
    names: spyOn(Herdr, "agentNames").mockReturnValue(OkAsync(agents)),
    close: spyOn(Herdr, "closePane").mockReturnValue(OkAsync("closed" as const)),
  };
}

test("a worker submits a numbered report with copied supporting files", async () => {
  const sourceId = await device.source();
  const launch = await device.launch(sourceId);
  const notes = `${device.root}/drafts/notes.md`;
  const log = `${device.root}/drafts/run.log`;
  await Bun.write(notes, "first notes\n");
  await Bun.write(log, "log\n");
  const file = await device.writeJson("report.json", { ...draft, files: [notes, log] });
  const { reports, directory } = device.assignmentFiles(sourceId);
  // A destination that a stopped publish left behind is replaced.
  await Bun.write(`${reports}/1/stale.md`, "stale\n");
  device.inPane(workerPane);

  expect(okValue(await ReportAssignments.submit({ paths: device.paths, file }))).toEqual({
    reason: "report_submitted",
    data: {
      sourceId,
      assignment: "read",
      state: "reported",
      report: 1,
      file: `${reports}/1/report.md`,
      files: [`${reports}/1/files/notes.md`, `${reports}/1/files/run.log`],
    },
  });
  expect(await device.files(`${reports}/1`)).toEqual([
    "files/notes.md",
    "files/run.log",
    "report.md",
  ]);
  expect(await Bun.file(`${reports}/1/report.md`).text()).toBe(`# Report 1 for read

## Conclusion

The module has two gaps.

## Evidence

- modules/a.ts:10 reads no state.

## Unresolved points

- Whether the scope includes b.ts.

## Human answers

- Is b.ts in scope? Answer: No.

## SuperAgent decisions

A SuperAgent decision is not a human answer.

- Which name? Answer: Use reader.

## Supporting files

- \`${reports}/1/files/notes.md\`
- \`${reports}/1/files/run.log\`
`);
  // A later change to the draft cannot change the report.
  await Bun.write(notes, "changed\n");
  expect(await Bun.file(`${reports}/1/files/notes.md`).text()).toBe("first notes\n");
  expect(await readdir(`${directory}/pending`)).toEqual([]);

  const shown = await device.show(sourceId);
  expect(shown.assignments).toEqual([
    { key: "read", completion: "report", state: "reported" },
    { key: "later", completion: "report", state: "ready" },
  ]);
  const row = shown.reports[0] ?? expect.unreachable();
  expect(shown.reports).toEqual([
    {
      assignment: "read",
      number: 1,
      launchId: launch.id,
      submittedAt: row.submittedAt,
      conclusion: draft.conclusion,
      evidence: draft.evidence,
      unresolved: draft.unresolved,
      decisions: draft.decisions,
      files: [`${reports}/1/files/notes.md`, `${reports}/1/files/run.log`],
      decision: null,
      decidedAt: null,
      followUp: null,
      cleanupState: null,
      cleanupDetail: null,
      reference: `operator:example/one/sources/${sourceId}/assignments/read/reports/1`,
    },
  ]);
  expect(Date.parse(row.submittedAt)).toBeGreaterThan(Date.now() - 60000);
});

test("submission needs the worker's own Herdr pane and reads no file without it", async () => {
  const sourceId = await device.source();
  await device.launch(sourceId);
  const missing = `${device.root}/drafts/missing.json`;
  const required = {
    reason: "worker_pane_required",
    detail:
      "Run this command in the Herdr pane that Operator dispatched for the assignment. Nothing changed.",
  };
  for (const [pane, server] of [
    [null, socket],
    [workerPane, null],
    [null, null],
  ] as const) {
    device.inPane(pane, server);
    expect(await ReportAssignments.submit({ paths: device.paths, file: missing })).toMatchObject({
      tag: "Err",
      error: required,
    });
    expect(await ReportAssignments.resume({ paths: device.paths })).toMatchObject({
      tag: "Err",
      error: required,
    });
    mock.restore();
  }
  const file = await device.writeJson("report.json", draft);
  for (const [pane, server] of [
    ["w1:p9", socket],
    [workerPane, "/elsewhere.sock"],
  ] as const) {
    device.inPane(pane, server);
    expect(await ReportAssignments.submit({ paths: device.paths, file })).toMatchObject({
      tag: "Err",
      error: { reason: "worker_launch_not_found" },
    });
    mock.restore();
  }
  expect((await device.show(sourceId)).reports).toEqual([]);
});

test("invalid or unreadable submissions are refusals that change nothing", async () => {
  const sourceId = await device.source();
  await device.launch(sourceId);
  const { reports, directory } = device.assignmentFiles(sourceId);
  device.inPane(workerPane);
  const broken = `${device.root}/drafts/broken.json`;
  await Bun.write(broken, "{broken");
  const invalid = await device.writeJson("invalid.json", { ...draft, evidence: [] });
  const folder = `${device.root}/drafts/folder`;
  await mkdir(folder, { recursive: true });
  const withFolder = await device.writeJson("folder.json", { ...draft, files: [folder] });

  for (const file of [broken, invalid]) {
    const result = await ReportAssignments.submit({ paths: device.paths, file });
    expect(result).toMatchObject({ tag: "Err", error: { reason: "invalid_report_input" } });
    expect(result.tag === "Err" && result.error.detail.endsWith(" Nothing changed.")).toBe(true);
  }
  const missing = await ReportAssignments.submit({
    paths: device.paths,
    file: `${device.root}/missing.json`,
  });
  expect(missing).toMatchObject({ tag: "Err", error: { reason: "report_io_failed" } });
  expect(missing.tag === "Err" && missing.error.detail.includes("ENOENT")).toBe(true);
  expect(await ReportAssignments.submit({ paths: device.paths, file: withFolder })).toMatchObject({
    tag: "Err",
    error: {
      reason: "invalid_report_input",
      detail: `Supporting file ${folder} is not a regular file. Nothing changed.`,
    },
  });
  expect(await listing(reports)).toBeNull();
  expect(await listing(directory)).toBeNull();
  expect((await device.show(sourceId)).assignments[0]).toMatchObject({ state: "running" });
});

test("a decision that changes before the write publishes no report", async () => {
  const sourceId = await device.source();
  await device.launch(sourceId);
  const file = await device.writeJson("report.json", draft);
  const { reports, directory } = device.assignmentFiles(sourceId);
  const original = DeviceState.readReport;
  // The first read sees a returned report 4, so it decides report 5, and the write decides 1.
  spyOn(DeviceState, "readReport").mockImplementation((paths, target) =>
    original(paths, target).map((facts) => ({
      ...facts,
      reports: [
        {
          sourceId,
          assignment: "read",
          number: 4,
          launchId: facts.launch?.id ?? "",
          submittedAt: "earlier",
          conclusion: "Old.",
          evidence: "[]",
          unresolved: "[]",
          decisions: "[]",
          files: "[]",
          decision: "returned",
          decidedAt: "earlier",
          followUp: "Again.",
          cleanupState: null,
          cleanupDetail: null,
        },
      ],
    })),
  );
  device.inPane(workerPane);
  expect(await ReportAssignments.submit({ paths: device.paths, file })).toMatchObject({
    tag: "Err",
    error: {
      reason: "report_changed",
      detail: "The assignment changed during this command. Read operator next. Nothing changed.",
    },
  });
  expect(await readdir(`${directory}/pending`)).toEqual([]);
  expect(await listing(reports)).toBeNull();
  mock.restore();
  expect((await device.show(sourceId)).reports).toEqual([]);
});

test("a reported assignment awaits the SuperAgent and its worker cannot decide", async () => {
  const { sourceId, file } = await submitted();
  device.inPane(workerPane);
  expect(await ReportAssignments.submit({ paths: device.paths, file })).toMatchObject({
    tag: "Err",
    error: { reason: "report_awaiting_decision" },
  });
  expect(await ReportAssignments.resume({ paths: device.paths })).toMatchObject({
    tag: "Err",
    error: { reason: "report_not_returned" },
  });
  expect(await accept(sourceId)).toMatchObject({
    tag: "Err",
    error: { reason: "self_decision_refused" },
  });
  mock.restore();
  device.inPane(superPane);
  expect(
    await ReportAssignments.accept({
      paths: device.paths,
      cwd: device.root,
      sourceId,
      assignment: "read",
    }),
  ).toMatchObject({ tag: "Err", error: { reason: "git_checkout_invalid" } });
  expect((await device.show(sourceId)).reports).toMatchObject([{ number: 1, decision: null }]);
});

test("a returned report resumes the live worker with its follow-up", async () => {
  const { sourceId } = await submitted();
  const { followUps, directory } = device.assignmentFiles(sourceId);

  expect(okValue(await returned(sourceId, "  Read b.ts too.\n\n"))).toEqual({
    reason: "report_returned",
    data: {
      sourceId,
      assignment: "read",
      report: 1,
      followUp: `${followUps}/1.md`,
      next: "resume_worker",
    },
  });
  expect(await Bun.file(`${followUps}/1.md`).text()).toBe("Read b.ts too.\n");
  expect(await readdir(`${directory}/pending`)).toEqual([]);
  expect((await device.show(sourceId)).reports).toMatchObject([
    { number: 1, decision: "returned", followUp: "Read b.ts too.", cleanupState: null },
  ]);
  expect(Date.parse((await device.show(sourceId)).reports[0]?.decidedAt ?? "")).toBeGreaterThan(
    Date.now() - 60000,
  );
  // A report decides once.
  expect(await returned(sourceId)).toMatchObject({
    tag: "Err",
    error: { reason: "report_not_submitted" },
  });

  device.inPane(workerPane);
  expect(okValue(await ReportAssignments.resume({ paths: device.paths }))).toEqual({
    reason: "report_resumed",
    data: { sourceId, assignment: "read", state: "running", followUp: `${followUps}/1.md` },
  });
  expect(await device.states(sourceId)).toEqual({ read: "running", later: "ready" });
  expect(await ReportAssignments.resume({ paths: device.paths })).toMatchObject({
    tag: "Err",
    error: { reason: "report_not_returned" },
  });

  // The resumed worker submits report 2.
  const file = await device.writeJson("second.json", draft);
  expect(okValue(await ReportAssignments.submit({ paths: device.paths, file }))).toMatchObject({
    data: { report: 2, file: `${device.assignmentFiles(sourceId).reports}/2/report.md` },
  });
});

test("a returned report of a stopped worker needs a replacement worker", async () => {
  const { sourceId } = await submitted();
  expect(
    DeviceState.observePane(device.paths, {
      socket,
      paneId: workerPane,
      workspaceId: "w1",
      observation: { exited: true },
    }).tag,
  ).toBe("Ok");
  expect(okValue(await returned(sourceId))).toMatchObject({
    reason: "report_returned",
    data: { next: "replace_worker" },
  });
});

test("an empty follow-up or a changed decision returns nothing", async () => {
  const { sourceId } = await submitted();
  const { followUps, directory } = device.assignmentFiles(sourceId);
  expect(await returned(sourceId, " \n")).toMatchObject({
    tag: "Err",
    error: { reason: "invalid_report_input" },
  });
  const original = DeviceState.readReport;
  spyOn(DeviceState, "readReport").mockImplementation((paths, target) =>
    original(paths, target).map((facts) => ({
      ...facts,
      reports: facts.reports.map((row) => ({ ...row, number: 3 })),
    })),
  );
  const file = `${device.root}/drafts/follow-up.md`;
  await Bun.write(file, "Again.");
  device.inPane(superPane);
  expect(
    await ReportAssignments.return({
      paths: device.paths,
      cwd: device.checkout,
      sourceId,
      assignment: "read",
      file,
    }),
  ).toMatchObject({ tag: "Err", error: { reason: "report_changed" } });
  mock.restore();
  expect(await readdir(`${directory}/pending`)).toEqual([]);
  expect(await listing(followUps)).toBeNull();
  expect((await device.show(sourceId)).reports).toMatchObject([{ decision: null }]);
});

test("acceptance completes the report, closes the worker pane, and leaves the source open", async () => {
  const { sourceId, launch } = await submitted();
  const { reports } = device.assignmentFiles(sourceId);
  device.inPane(superPane);
  const seen: unknown[] = [];
  const names = spyOn(Herdr, "agentNames").mockImplementation(() =>
    fromPromise(
      async () => {
        // The decision is recorded before any cleanup step starts.
        seen.push((await device.show(sourceId)).reports[0]);
        return ["other", launch.name];
      },
      (cause, defect) => defect(cause),
    ),
  );
  const close = spyOn(Herdr, "closePane").mockReturnValue(OkAsync("closed" as const));

  expect(okValue(await accept(sourceId))).toEqual({
    reason: "report_accepted",
    data: {
      sourceId,
      assignment: "read",
      state: "completed",
      sourceFinished: false,
      report: 1,
      conclusion: draft.conclusion,
      unresolved: draft.unresolved,
      file: `${reports}/1/report.md`,
      reference: `operator:example/one/sources/${sourceId}/assignments/read/reports/1`,
      cleanup: { state: "done", detail: `Closed pane ${workerPane}.` },
    },
  });
  expect(seen).toMatchObject([{ decision: "accepted", cleanupState: "pending" }]);
  expect(names).toHaveBeenCalledTimes(1);
  expect(close.mock.calls).toEqual([[workerPane]]);
  const shown = await device.show(sourceId);
  expect(shown.state).toBe("open");
  expect(shown.endedAt).toBeNull();
  expect(shown.assignments[0]).toMatchObject({ state: "completed" });
  expect(shown.launches).toMatchObject([{ id: launch.id, state: "finished" }]);
  expect(shown.reports).toMatchObject([
    { decision: "accepted", cleanupState: "done", cleanupDetail: `Closed pane ${workerPane}.` },
  ]);
  expect(Date.parse(shown.reports[0]?.decidedAt ?? "")).toBeGreaterThan(Date.now() - 60000);
  // An accepted report with finished cleanup cannot be accepted again.
  expect(await accept(sourceId)).toMatchObject({
    tag: "Err",
    error: { reason: "report_not_submitted" },
  });
});

test("acceptance of the last assignment finishes the source", async () => {
  const { sourceId, launch } = await submitted(["read"]);
  device.inPane(superPane);
  const { close } = herdr(["other"]);
  expect(okValue(await accept(sourceId))).toMatchObject({
    reason: "report_accepted",
    data: {
      sourceFinished: true,
      cleanup: { state: "done", detail: `Pane ${workerPane} no longer holds ${launch.name}.` },
    },
  });
  expect(close).not.toHaveBeenCalled();
  const shown = await device.show(sourceId);
  expect(shown.state).toBe("finished");
  expect(Date.parse(shown.endedAt ?? "")).toBeGreaterThan(Date.now() - 60000);
});

test("a failed cleanup stays visible and a repeated acceptance retries only the cleanup", async () => {
  const { sourceId, launch } = await submitted();
  device.inPane(superPane, "/elsewhere.sock");
  const { names } = herdr([launch.name]);
  expect(okValue(await accept(sourceId))).toMatchObject({
    reason: "report_accepted",
    data: {
      cleanup: {
        state: "failed",
        detail: `Pane ${workerPane} belongs to another Herdr server. Repeat report accept in a pane of that server.`,
      },
    },
  });
  expect(names).not.toHaveBeenCalled();
  const first = (await device.show(sourceId)).reports[0] ?? expect.unreachable();
  expect(first).toMatchObject({ decision: "accepted", cleanupState: "failed" });
  mock.restore();

  device.inPane(superPane);
  const seen: unknown[] = [];
  spyOn(Herdr, "agentNames").mockImplementation(() =>
    fromPromise(
      async () => {
        seen.push((await device.show(sourceId)).reports[0]);
        return [launch.name];
      },
      (cause, defect) => defect(cause),
    ),
  );
  const close = spyOn(Herdr, "closePane").mockReturnValue(OkAsync("closed" as const));
  expect(okValue(await accept(sourceId))).toMatchObject({
    reason: "report_cleanup_retried",
    data: {
      state: "completed",
      sourceFinished: false,
      report: 1,
      cleanup: { state: "done", detail: `Closed pane ${workerPane}.` },
    },
  });
  // The retry keeps the recorded decision and reopens only the cleanup.
  expect(seen).toEqual([{ ...first, cleanupState: "pending" }]);
  expect(close.mock.calls).toEqual([[workerPane]]);
  expect((await device.show(sourceId)).reports).toEqual([
    { ...first, cleanupState: "done", cleanupDetail: `Closed pane ${workerPane}.` },
  ]);
});

test.each([
  {
    name: "a Herdr refusal",
    names: () => ErrAsync({ reason: "herdr_failed" as const, detail: "Herdr refused." }),
    close: () => OkAsync("closed" as const),
    detail: "Herdr refused.",
  },
  {
    name: "a Herdr defect",
    names: () => fromPromise(Promise.reject(new Error("lost")), (cause, defect) => defect(cause)),
    close: () => OkAsync("closed" as const),
    detail: "Error: lost",
  },
  {
    name: "a refused pane close",
    names: () => OkAsync(["report-read"]),
    close: () => ErrAsync({ reason: "herdr_failed" as const, detail: "Close refused." }),
    detail: "Close refused.",
  },
  {
    name: "a pane close defect",
    names: () => OkAsync(["report-read"]),
    close: () => fromPromise(Promise.reject(new Error("gone")), (cause, defect) => defect(cause)),
    detail: "Error: gone",
  },
])("$name fails the cleanup but keeps the acceptance", async (change) => {
  const { sourceId, launch } = await submitted();
  device.inPane(superPane);
  spyOn(Herdr, "agentNames").mockImplementation(() =>
    change
      .names()
      .map((agents) => agents.map((agent) => (agent === "report-read" ? launch.name : agent))),
  );
  spyOn(Herdr, "closePane").mockImplementation(change.close);
  expect(okValue(await accept(sourceId))).toMatchObject({
    reason: "report_accepted",
    data: { cleanup: { state: "failed", detail: change.detail } },
  });
  expect((await device.show(sourceId)).reports).toMatchObject([
    { decision: "accepted", cleanupState: "failed", cleanupDetail: change.detail },
  ]);
});

test("acceptance cleans the worker worktree from the controlling checkout", async () => {
  const sourceId = await device.source();
  const worktree = `${device.root}/worktrees/read`;
  const launch = await device.launch(sourceId, "read", {
    worktreePath: worktree,
    branch: "task/read",
  });
  const file = await device.writeJson("report.json", draft);
  device.inPane(workerPane);
  okValue(await ReportAssignments.submit({ paths: device.paths, file }));
  mock.restore();
  device.inPane(superPane);
  herdr([launch.name]);
  const clean = spyOn(WorkerDispatch, "cleanWorktree");
  expect(okValue(await accept(sourceId))).toMatchObject({
    data: {
      cleanup: {
        state: "done",
        detail: `Closed pane ${workerPane}. Worktree ${worktree} no longer exists.`,
      },
    },
  });
  expect(clean.mock.calls).toEqual([
    [{ checkout: device.checkout, worktree, branch: "task/read" }],
  ]);
  mock.restore();
});

test("a worktree cleanup defect fails the cleanup", async () => {
  const sourceId = await device.source();
  const launch = await device.launch(sourceId, "read", { worktreePath: "/gone" });
  const file = await device.writeJson("report.json", draft);
  device.inPane(workerPane);
  okValue(await ReportAssignments.submit({ paths: device.paths, file }));
  mock.restore();
  device.inPane(superPane);
  herdr([launch.name]);
  spyOn(WorkerDispatch, "cleanWorktree").mockRejectedValue(new Error("git stopped"));
  expect(okValue(await accept(sourceId))).toMatchObject({
    data: { cleanup: { state: "failed", detail: "Error: git stopped" } },
  });
});

test("an ended worker launch leaves no pane to close", async () => {
  const { sourceId } = await submitted();
  expect(
    DeviceState.observePane(device.paths, {
      socket,
      paneId: workerPane,
      workspaceId: "w1",
      observation: { exited: true },
    }).tag,
  ).toBe("Ok");
  device.inPane(superPane);
  const { names } = herdr([]);
  expect(okValue(await accept(sourceId))).toMatchObject({
    data: { cleanup: { state: "done", detail: "No pane or worktree to clean up." } },
  });
  expect(names).not.toHaveBeenCalled();
  expect((await device.show(sourceId)).launches).toMatchObject([{ state: "interrupted" }]);
});

test.each([
  // An ended launch is not finished by acceptance, so both reads decide the same transition.
  { name: "no launch", withLaunch: false, exited: true },
  { name: "a launch with no pane", withLaunch: true, exited: false },
])("a report whose facts show $name skips the pane", async (change) => {
  const { sourceId } = await submitted();
  if (change.exited)
    DeviceState.observePane(device.paths, {
      socket,
      paneId: workerPane,
      workspaceId: "w1",
      observation: { exited: true },
    });
  const original = DeviceState.readReport;
  spyOn(DeviceState, "readReport").mockImplementation((paths, target) =>
    original(paths, target).map((facts) => ({
      ...facts,
      launch: facts.launch !== null && change.withLaunch ? { ...facts.launch, paneId: null } : null,
    })),
  );
  device.inPane(superPane);
  const { names } = herdr([]);
  expect(okValue(await accept(sourceId))).toMatchObject({
    data: { cleanup: { state: "done", detail: "No pane or worktree to clean up." } },
  });
  expect(names).not.toHaveBeenCalled();
});

test("acceptance reports the accepted report of its own assignment", async () => {
  // The other assignment's report is listed after the accepted one.
  const { sourceId } = await submitted(["read", "zeta"]);
  await device.launch(sourceId, "zeta", { paneId: "w1:p2" });
  const file = await device.writeJson("later.json", { ...draft, conclusion: "Later." });
  device.inPane("w1:p2");
  okValue(await ReportAssignments.submit({ paths: device.paths, file }));
  mock.restore();
  device.inPane(superPane);
  herdr([]);
  expect(okValue(await accept(sourceId))).toMatchObject({
    data: { assignment: "read", conclusion: draft.conclusion, sourceFinished: false },
  });
});

test("acceptance stops when its cleanup record or the accepted report cannot be read", async () => {
  const { sourceId } = await submitted();
  device.inPane(superPane);
  herdr([]);
  const original = DeviceState.changeReport;
  let calls = 0;
  spyOn(DeviceState, "changeReport").mockImplementation((paths, target, decide) =>
    ++calls === 1
      ? original(paths, target, decide)
      : Err({ reason: "state_busy" as const, detail: "Busy." }),
  );
  expect(await accept(sourceId)).toMatchObject({
    tag: "Err",
    error: { reason: "state_busy", detail: "Busy." },
  });
  mock.restore();
  expect((await device.show(sourceId)).reports).toMatchObject([{ cleanupState: "pending" }]);

  device.inPane(superPane);
  herdr([]);
  spyOn(WorkSources, "show").mockReturnValue(OkAsync(undefined));
  expect(await accept(sourceId)).toMatchObject({
    tag: "Err",
    error: { reason: "report_defect", detail: "The accepted report is not recorded." },
  });
});

/** The first read sees report 3, so its decision differs from the one that the write makes. */
function changedBeforeWrite() {
  const original = DeviceState.readReport;
  spyOn(DeviceState, "readReport").mockImplementation((paths, target) =>
    original(paths, target).map((facts) => ({
      ...facts,
      reports: facts.reports.map((row) => ({ ...row, number: 3 })),
    })),
  );
}

test("resume refuses a decision that changed before the write", async () => {
  const { sourceId } = await submitted();
  okValue(await returned(sourceId));
  changedBeforeWrite();
  device.inPane(workerPane);
  expect(await ReportAssignments.resume({ paths: device.paths })).toMatchObject({
    tag: "Err",
    error: { reason: "report_changed" },
  });
  expect(await device.states(sourceId)).toEqual({ read: "reported", later: "ready" });
});

test("acceptance refuses a decision that changed before the write", async () => {
  const other = await submitted();
  changedBeforeWrite();
  device.inPane(superPane);
  const { names } = herdr([]);
  expect(await accept(other.sourceId)).toMatchObject({
    tag: "Err",
    error: { reason: "report_changed" },
  });
  expect(names).not.toHaveBeenCalled();
  expect((await device.show(other.sourceId)).reports).toMatchObject([{ decision: null }]);
});

test("a return outside the controlling checkout changes nothing", async () => {
  const { sourceId } = await submitted();
  const file = `${device.root}/drafts/follow-up.md`;
  await Bun.write(file, "Again.");
  device.inPane(superPane);
  expect(
    await ReportAssignments.return({
      paths: device.paths,
      cwd: device.root,
      sourceId,
      assignment: "read",
      file,
    }),
  ).toMatchObject({ tag: "Err", error: { reason: "git_checkout_invalid" } });
  expect((await device.show(sourceId)).reports).toMatchObject([{ decision: null }]);
});

test("a file system failure during resume or acceptance is a refusal", async () => {
  const { sourceId } = await submitted();
  okValue(await returned(sourceId));
  const failure = Object.assign(new Error("EIO: i/o error"), { code: "EIO" });
  const read = spyOn(DeviceState, "readReport").mockImplementation(() => {
    // oxlint-disable-next-line unthrown/no-throw -- Inject a thrown I/O failure at the device-state interface.
    throw failure;
  });
  device.inPane(workerPane);
  expect(await ReportAssignments.resume({ paths: device.paths })).toMatchObject({
    tag: "Err",
    error: { reason: "report_io_failed", detail: "Error: EIO: i/o error" },
  });
  read.mockRestore();
  okValue(await ReportAssignments.resume({ paths: device.paths }));
  const file = await device.writeJson("second.json", draft);
  okValue(await ReportAssignments.submit({ paths: device.paths, file }));
  mock.restore();
  device.inPane(superPane);
  spyOn(Herdr, "agentNames").mockImplementation(() => {
    // oxlint-disable-next-line unthrown/no-throw -- Inject a thrown I/O failure at the Herdr interface.
    throw failure;
  });
  expect(await accept(sourceId)).toMatchObject({
    tag: "Err",
    error: { reason: "report_io_failed", detail: "Error: EIO: i/o error" },
  });
  // The acceptance is recorded before the cleanup step fails.
  expect((await device.show(sourceId)).reports.at(-1)).toMatchObject({
    number: 2,
    decision: "accepted",
    cleanupState: "pending",
  });
});
