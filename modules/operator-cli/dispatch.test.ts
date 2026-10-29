import { afterEach, expect, mock, spyOn, test } from "bun:test";
// Bun has no platform temporary-root API.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { ErrAsync, fromSafePromise, OkAsync } from "unthrown";
import { Environment } from "../environment/main.ts";
import { OperatorHome } from "../operator-home/main.ts";
import { WorkerDispatch } from "../worker-dispatch/main.ts";
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
    dispatch: spyOn(WorkerDispatch, "dispatch").mockReturnValue(OkAsync({ pane: "1" }) as never),
    installPlugin: spyOn(WorkerDispatch, "installPlugin").mockReturnValue(
      OkAsync({ reason: "herdr_plugin_installed", data: { plugin: true } }) as never,
    ),
    observe: spyOn(WorkerDispatch, "observe").mockReturnValue(
      OkAsync({ reason: "herdr_event_recorded", data: { event: true } }) as never,
    ),
  };
}

test("parses dispatch and Herdr commands", () => {
  expect(dispatchArgs(["dispatch", "--source", "s", "--assignment", "a", "--json"])).toEqual({
    operation: "dispatch",
    sourceId: "s",
    assignment: "a",
  });
  expect(dispatchArgs(["dispatch", "--json", "--assignment", "a", "--source", "s"])).toEqual({
    operation: "dispatch",
    sourceId: "s",
    assignment: "a",
  });
  expect(dispatchArgs(["herdr", "install"])).toEqual({ operation: "herdr_install" });
  expect(dispatchArgs(["herdr", "event", "--json"])).toEqual({ operation: "herdr_event" });
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
    ErrAsync({ reason, detail: "not observed" }) as never,
  );
  const { log, error } = quiet();
  expect(await runDispatch(["herdr", "event", "--json"], paths, true)).toBe(true);
  expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toMatchObject({
    operation: "herdr_event",
    reason,
  });
  expect(error).toHaveBeenCalledWith("operator: not observed");
  expect(process.exitCode).toBe(code);
});

test("reports a dispatch defect with exit code 1", async () => {
  spyOn(WorkerDispatch, "dispatch").mockReturnValue(
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
  expect(error).toHaveBeenCalledWith("operator: Error: boom");
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
