import { afterEach, expect, mock, spyOn, test } from "bun:test";
// Bun has no platform temporary-root API.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { ErrAsync, fromSafePromise, fromPromise, OkAsync } from "unthrown";
import { Environment } from "../environment/main.ts";
import { OperatorHome } from "../operator-home/main.ts";
import { WorkerDispatch } from "../worker-dispatch/main.ts";
import { WorkSources } from "../work-sources/main.ts";
import { PullRequests } from "../pull-requests/main.ts";
import { dispatchArgs, herdrEventWithoutState, runDispatch } from "./dispatch.ts";

const paths = OperatorHome.resolve(
  Environment.parse({
    HOME: "/isolated",
    XDG_CONFIG_HOME: "/isolated/config",
    XDG_STATE_HOME: "/isolated/state",
  }),
);

afterEach(() => {
  mock.restore();
  process.exitCode = 0;
});

function quiet() {
  return {
    log: spyOn(console, "log").mockImplementation(() => {}),
    error: spyOn(console, "error").mockImplementation(() => {}),
  };
}

function spies() {
  return {
    dispatch: spyOn(PullRequests, "dispatch").mockReturnValue(OkAsync({ pane: "1" }) as never),
    installPlugin: spyOn(WorkerDispatch, "installPlugin").mockReturnValue(
      OkAsync({ reason: "herdr_plugin_installed", data: { plugin: true } }) as never,
    ),
    observe: spyOn(WorkerDispatch, "observe").mockReturnValue(
      OkAsync({ reason: "herdr_event_recorded", data: { event: true } }) as never,
    ),
  };
}

test("a dispatch defect uses the command boundary reason and exit status rather than an operational refusal", async () => {
  const cause = new Error("permission defect", { cause: { original: true } });
  const defect = await fromPromise(Promise.reject(cause), (error, unexpected) => unexpected(error));
  spyOn(PullRequests, "dispatch").mockReturnValue(defect.toAsync());
  const { log, error } = quiet();
  expect(
    await runDispatch(["dispatch", "--source", "s", "--assignment", "a", "--json"], paths, true),
  ).toBe(true);
  expect(process.exitCode).toBe(1);
  expect(JSON.parse(String(log.mock.lastCall?.[0]))).toMatchObject({
    operation: "dispatch",
    reason: "dispatch_defect",
    outcome: "refused",
    blockers: [{ reason: "dispatch_defect", detail: "Error: permission defect" }],
  });
  expect(error).toHaveBeenCalled();
});

test("parses dispatch and Herdr commands", () => {
  expect(dispatchArgs(["abandon", "--source", "s", "--assignment", "a", "--json"])).toEqual({
    operation: "abandon",
    sourceId: "s",
    assignment: "a",
  });
  expect(dispatchArgs(["dispatch", "--source", "s", "--assignment", "a", "--json"])).toStrictEqual({
    operation: "dispatch",
    sourceId: "s",
    assignment: "a",
    afterPid: null,
  });
  expect(
    dispatchArgs(["dispatch", "--source", "s", "--assignment", "a", "--kind", "research"]),
  ).toEqual({
    operation: "dispatch",
    sourceId: "s",
    assignment: "a",
    afterPid: null,
    kind: "research",
  });
  expect(
    dispatchArgs(["abandon", "--source", "s", "--assignment", "a", "--kind", "research"]),
  ).toBeNull();
  expect(dispatchArgs(["dispatch", "--json", "--assignment", "a", "--source", "s"])).toEqual({
    operation: "dispatch",
    sourceId: "s",
    assignment: "a",
    afterPid: null,
  });
  expect(dispatchArgs(["herdr", "install"])).toEqual({ operation: "herdr_install" });
  expect(dispatchArgs(["herdr", "event", "--json"])).toEqual({ operation: "herdr_event" });
});

test("one-off dispatch and registered kind filling keep distinct selectors", () => {
  expect(dispatchArgs(["dispatch", "--kind", "answer", "--brief", "task.md"])).toStrictEqual({
    operation: "one_off_dispatch",
    kind: "answer",
    brief: "task.md",
    intentFile: undefined,
    profile: undefined,
    trackerKey: undefined,
  });
  for (const args of [
    ["dispatch", "--brief", "task.md"],
    ["dispatch", "--kind", "answer"],
    ["dispatch", "--source", "s", "--assignment", "a", "--profile", "careful"],
    ["dispatch", "--source", "s", "--assignment", "a", "--intent-file", "intent.md"],
    ["dispatch", "--source", "s", "--assignment", "a", "--tracker-key", "APP-1"],
    ["dispatch", "--source", "s", "--assignment", "a", "--kind", "answer", "--brief", "task.md"],
  ])
    expect(dispatchArgs(args)).toBeNull();
});

test("only registered dispatch accepts a numeric continuation publication PID", async () => {
  const called = spies();
  quiet();
  expect(
    await runDispatch(
      ["dispatch", "--source", "s", "--assignment", "a", "--after-pid", "123"],
      paths,
      true,
    ),
  ).toBe(true);
  expect(called.dispatch).toHaveBeenCalledWith({
    paths,
    cwd: process.cwd(),
    sourceId: "s",
    assignment: "a",
    afterPid: 123,
  });
  called.dispatch.mockClear();
  for (const args of [
    ["dispatch", "--source", "s", "--assignment", "a", "--after-pid", "invalid"],
    ["dispatch", "--source", "s", "--assignment", "a", "--after-pid", "12345678901"],
    ["abandon", "--source", "s", "--assignment", "a", "--after-pid", "123"],
    ["dispatch", "--kind", "implementation", "--brief", "task.md", "--after-pid", "123"],
  ]) {
    expect(dispatchArgs(args)).toBeNull();
    expect(await runDispatch(args, paths, true)).toBe(false);
  }
  expect(called.dispatch).not.toHaveBeenCalled();
});

test("abandon passes its exact selector and preserves the result and next without launching or observing a worker", async () => {
  const called = spies();
  const next = { command: "operator next --source s", why: "Read remaining work." };
  const abandon = spyOn(WorkSources, "abandon").mockReturnValue(
    OkAsync({ sourceId: "s", assignment: "a", ended: ["a"], retained: [], next }),
  );
  const { log } = quiet();
  expect(
    await runDispatch(["abandon", "--source", "s", "--assignment", "a", "--json"], paths, true),
  ).toBe(true);
  expect(abandon).toHaveBeenCalledWith({
    paths,
    cwd: process.cwd(),
    sourceId: "s",
    assignment: "a",
  });
  expect(JSON.parse(String(log.mock.lastCall?.[0]))).toMatchObject({
    operation: "abandon",
    reason: "assignment_abandoned",
    data: { sourceId: "s", assignment: "a", ended: ["a"], retained: [] },
    next,
  });
  for (const call of Object.values(called)) expect(call).not.toHaveBeenCalled();
});

test.each([
  [["other"]],
  [["other", "--source", "s", "--assignment", "a"]],
  [["dispatch", "--assignment", "a", "--source", "--json"]],
  [["herdr"]],
  [["herdr", "remove"]],
  [["herdr", "event", "--json", "--json"]],
  [["herdr", "install", "--force"]],
  [["dispatch"]],
  [["dispatch", "--source", "s"]],
  [["dispatch", "--assignment", "a"]],
  [["dispatch", "--source", "s", "--assignment", "a", "--json", "--json"]],
  [["dispatch", "--source", "s", "--source", "t", "--assignment", "a"]],
  [["dispatch", "--source", "s", "--assignment"]],
  [["dispatch", "--source", "--assignment", "a"]],
  [["dispatch", "--source", "s", "--assignment", "a", "--other", "x"]],
])("refuses %j before any dispatch operation", async (args) => {
  const called = spies();
  expect(dispatchArgs(args)).toBeNull();
  expect(await runDispatch(args, paths, true)).toBe(false);
  for (const spy of Object.values(called)) expect(spy).not.toHaveBeenCalled();
});

test("passes each command to the matching dispatch operation", async () => {
  const called = spies();
  const { log } = quiet();
  await runDispatch(["dispatch", "--source", "s", "--assignment", "a"], paths, true);
  expect(called.dispatch).toHaveBeenCalledWith({
    paths,
    cwd: process.cwd(),
    sourceId: "s",
    assignment: "a",
    afterPid: null,
    kind: undefined,
  });
  expect(JSON.parse(String(log.mock.lastCall?.[0]))).toMatchObject({
    operation: "dispatch",
    reason: "worker_launched",
    data: { pane: "1" },
  });
  await runDispatch(["herdr", "install"], paths, true);
  expect(called.installPlugin).toHaveBeenCalledWith({ paths });
  await runDispatch(["herdr", "event"], paths, true);
  expect(called.observe).toHaveBeenCalledWith({ paths });
  for (const spy of Object.values(called)) expect(spy).toHaveBeenCalledTimes(1);
});

test("recovered parking reports no worker launch", async () => {
  spyOn(PullRequests, "dispatch").mockReturnValue(
    OkAsync({ sourceId: "s", assignment: "a", parked: true }),
  );
  const { log } = quiet();
  expect(
    await runDispatch(["dispatch", "--source", "s", "--assignment", "a", "--json"], paths, true),
  ).toBe(true);
  expect(JSON.parse(String(log.mock.lastCall?.[0]))).toMatchObject({
    reason: "pr_parked",
    data: { sourceId: "s", assignment: "a", parked: true },
  });
  expect(process.exitCode).toBe(0);
});

test("prints a completed operation as compact JSON or as indented text", async () => {
  spies();
  const { log } = quiet();
  const expected = {
    schemaVersion: 1,
    operation: "herdr_install",
    outcome: "completed",
    reason: "herdr_plugin_installed",
    blockers: [],
    data: { plugin: true },
  };
  process.exitCode = 7;
  expect(await runDispatch(["herdr", "install"], paths, true)).toBe(true);
  expect(log).toHaveBeenLastCalledWith(JSON.stringify(expected));
  expect(process.exitCode).toBe(0);
  expect(await runDispatch(["herdr", "install"], paths, false)).toBe(true);
  expect(log).toHaveBeenLastCalledWith(JSON.stringify(expected, null, 2));
});

test.each([
  ["controller_mismatch", 4],
  ["controller_identity_mismatch", 4],
  ["assignment_not_dispatchable", 4],
  ["running_cap_reached", 4],
  ["launch_failed", 1],
  ["launch_interrupted", 1],
  ["state_busy", 1],
  ["state_io_failed", 1],
  ["dispatch_io_failed", 1],
  ["preparation_failed", 1],
  ["preparation_io_failed", 1],
  ["herdr_failed", 1],
  ["herdr_no_answer", 1],
  ["herdr_invalid_response", 1],
  ["host_metadata_failed", 1],
  ["settings_io_failed", 1],
  ["assignment_blocked", 3],
])("refuses %s with exit code %d", async (reason, code) => {
  spyOn(WorkerDispatch, "observe").mockReturnValue(
    ErrAsync({
      reason,
      detail: "not observed",
      next: {
        decider: "super-agent",
        question: "How should this simulated dispatch refusal be resolved?",
      },
    }),
  );
  const { log, error } = quiet();
  expect(await runDispatch(["herdr", "event", "--json"], paths, true)).toBe(true);
  expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toMatchObject({
    operation: "herdr_event",
    reason,
  });
  expect(error).toHaveBeenCalledWith(`operator: ${reason}: not observed`);
  expect(error).toHaveBeenCalledWith(
    "next: super-agent decides: How should this simulated dispatch refusal be resolved?",
  );
  expect(process.exitCode).toBe(code);
});

test("reports a dispatch defect with exit code 1", async () => {
  spyOn(PullRequests, "dispatch").mockReturnValue(
    fromSafePromise(() => Promise.reject(new Error("boom"))),
  );
  const { log, error } = quiet();
  expect(await runDispatch(["dispatch", "--source", "s", "--assignment", "a"], paths, true)).toBe(
    true,
  );
  expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toMatchObject({
    operation: "dispatch",
    reason: "dispatch_defect",
  });
  expect(error.mock.calls.map(([line]) => String(line))).toEqual([
    "operator: dispatch_defect: Error: boom",
    "next: super-agent decides: How should dispatch_defect be corrected before retrying dispatch?",
  ]);
  expect(process.exitCode).toBe(1);
});

test("ignores a Herdr event only while the device has no state", async () => {
  const home = mkdtempSync(`${tmpdir()}/dispatch-event-`);
  const local = OperatorHome.resolve(Environment.parse({ HOME: home, NODE_ENV: "test" }));
  const { log } = quiet();
  const expected = {
    schemaVersion: 1,
    operation: "herdr_event",
    outcome: "completed",
    reason: "herdr_event_ignored",
    blockers: [],
    data: { stateMissing: true },
  };
  try {
    expect(await herdrEventWithoutState(["herdr", "install"], local, true)).toBe(false);
    expect(await herdrEventWithoutState(["dispatch"], local, true)).toBe(false);
    expect(log).not.toHaveBeenCalled();
    process.exitCode = 7;
    expect(await herdrEventWithoutState(["herdr", "event", "--json"], local, true)).toBe(true);
    expect(log).toHaveBeenLastCalledWith(JSON.stringify(expected));
    expect(process.exitCode).toBe(0);
    expect(await herdrEventWithoutState(["herdr", "event"], local, false)).toBe(true);
    expect(log).toHaveBeenLastCalledWith(JSON.stringify(expected, null, 2));
    await Bun.write(local.database, "");
    log.mockClear();
    expect(await herdrEventWithoutState(["herdr", "event"], local, true)).toBe(false);
    expect(log).not.toHaveBeenCalled();
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
