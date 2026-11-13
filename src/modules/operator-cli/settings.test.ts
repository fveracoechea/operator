import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { ErrAsync, fromSafePromise, OkAsync } from "unthrown";
import { DeviceSettings } from "../device-settings/main.ts";
import { Environment } from "../environment/main.ts";
import { OperatorHome } from "../operator-home/main.ts";
import { runSettings } from "./settings.ts";

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

function completed(reason: string) {
  return OkAsync({ reason, data: { configured: true } }) as never;
}

function spies() {
  return {
    show: spyOn(DeviceSettings, "show").mockReturnValue(completed("settings_read")),
    recover: spyOn(DeviceSettings, "recover").mockReturnValue(completed("settings_recovered")),
    plan: spyOn(DeviceSettings, "plan").mockReturnValue(completed("settings_planned")),
    apply: spyOn(DeviceSettings, "apply").mockReturnValue(completed("settings_applied")),
  };
}

test.each([
  [["other", "show"]],
  [["config"]],
  [["config", "edit"]],
  [["config", "show", "--json", "--json"]],
  [["config", "show", "--set", "a=1"]],
  [["config", "recover", "--unset", "a"]],
  [["config", "plan", "--plan", "p"]],
  [["config", "show", "--plan", "p"]],
  [["config", "apply", "--plan", "p", "--plan", "q"]],
  [["config", "plan", "--set"]],
  [["config", "plan", "--set", "--json"]],
  [["config", "plan", "--other", "x"]],
  [["config", "apply", "--other", "x"]],
])("refuses %j before any settings operation", async (args) => {
  const called = spies();
  expect(await runSettings(args, paths, true)).toBe(false);
  for (const spy of Object.values(called)) expect(spy).not.toHaveBeenCalled();
});

test("passes each command and its edits to the matching settings operation", async () => {
  const called = spies();
  quiet();
  expect(await runSettings(["config", "show", "--json"], paths, true)).toBe(true);
  expect(called.show).toHaveBeenCalledWith(paths);
  expect(await runSettings(["config", "recover"], paths, true)).toBe(true);
  expect(called.recover).toHaveBeenCalledWith(paths);
  expect(
    await runSettings(
      ["config", "plan", "--set", "a=1", "--unset", "b", "--set", "c=2", "--json"],
      paths,
      true,
    ),
  ).toBe(true);
  expect(called.plan).toHaveBeenCalledWith({
    command: "plan",
    sets: ["a=1", "c=2"],
    unsets: ["b"],
    planId: undefined,
    paths,
    cwd: process.cwd(),
  });
  expect(await runSettings(["config", "apply", "--plan", "p1", "--set", "a=1"], paths, true)).toBe(
    true,
  );
  expect(called.apply).toHaveBeenCalledWith({
    command: "apply",
    sets: ["a=1"],
    unsets: [],
    planId: "p1",
    paths,
    cwd: process.cwd(),
  });
  expect(called.show).toHaveBeenCalledTimes(1);
  expect(called.recover).toHaveBeenCalledTimes(1);
  expect(called.plan).toHaveBeenCalledTimes(1);
  expect(called.apply).toHaveBeenCalledTimes(1);
});

test("prints a completed operation as compact JSON or as indented text", async () => {
  spies();
  const { log } = quiet();
  const expected = {
    schemaVersion: 1,
    operation: "config_plan",
    outcome: "completed",
    reason: "settings_planned",
    blockers: [],
    data: { configured: true },
  };
  process.exitCode = 7;
  await runSettings(["config", "plan", "--set", "a=1"], paths, true);
  expect(log).toHaveBeenLastCalledWith(JSON.stringify(expected));
  expect(process.exitCode).toBe(0);
  await runSettings(["config", "plan", "--set", "a=1"], paths, false);
  expect(log).toHaveBeenLastCalledWith(JSON.stringify(expected, null, 2));
});

test("refuses with the reason's settings exit code", async () => {
  spyOn(DeviceSettings, "apply").mockReturnValue(
    ErrAsync({ reason: "settings_plan_stale", detail: "stale plan" } as never),
  );
  const { log, error } = quiet();
  expect(await runSettings(["config", "apply", "--plan", "p"], paths, true)).toBe(true);
  expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toMatchObject({
    operation: "config_apply",
    reason: "settings_plan_stale",
  });
  expect(error).toHaveBeenCalledWith("operator: stale plan");
  expect(process.exitCode).toBe(4);
});

test("reports a settings defect with exit code 1", async () => {
  spyOn(DeviceSettings, "show").mockReturnValue(
    fromSafePromise(() => Promise.reject(new Error("boom"))),
  );
  const { log, error } = quiet();
  expect(await runSettings(["config", "show"], paths, true)).toBe(true);
  expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toMatchObject({
    operation: "config_show",
    reason: "settings_defect",
  });
  expect(error).toHaveBeenCalledWith("operator: Error: boom");
  expect(process.exitCode).toBe(1);
});
