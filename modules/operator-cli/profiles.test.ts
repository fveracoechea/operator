import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { ErrAsync, fromSafePromise, OkAsync } from "unthrown";
import { DeviceSettings } from "../device-settings/main.ts";
import { AgentHosts } from "../agent-hosts/main.ts";
import { OperatorHome } from "../operator-home/main.ts";
import { Environment } from "../environment/main.ts";
import { runProfiles } from "./profiles.ts";

afterEach(() => {
  mock.restore();
});

test("rejects malformed profile commands before any host metadata request", async () => {
  const models = spyOn(AgentHosts, "models");
  const paths = OperatorHome.resolve(
    Environment.parse({
      HOME: "/isolated",
      XDG_CONFIG_HOME: "/isolated/config",
      XDG_STATE_HOME: "/isolated/state",
    }),
  );
  for (const args of [
    ["host", "models"],
    ["host", "models", "--host", "other"],
    ["host", "models", "--host", "opencode", "--profile", "x"],
    ["config", "resolve", "--model"],
    ["config", "resolve", "--json", "--json"],
    ["config", "resolve", "--host", "opencode", "--host", "claude-code"],
    ["config", "resolve", "--unknown", "x"],
  ]) {
    expect(await runProfiles(args, paths, true)).toBe(false);
  }
  expect(models).not.toHaveBeenCalled();
});

test("formats metadata refusals and owns their exit status", async () => {
  spyOn(AgentHosts, "models").mockReturnValue(
    ErrAsync({ reason: "host_metadata_failed", detail: "invalid metadata" } as const),
  );
  const log = spyOn(console, "log").mockImplementation(() => {});
  spyOn(console, "error").mockImplementation(() => {});
  const paths = OperatorHome.resolve(
    Environment.parse({
      HOME: "/isolated",
      XDG_CONFIG_HOME: "/isolated/config",
      XDG_STATE_HOME: "/isolated/state",
    }),
  );
  expect(await runProfiles(["host", "models", "--host", "opencode"], paths, true)).toBe(true);
  expect(process.exitCode).toBe(1);
  process.exitCode = 0;
  expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toMatchObject({
    operation: "host_models",
    reason: "host_metadata_failed",
  });
});

test("keeps non-JSON metadata refusal output on stderr", async () => {
  spyOn(AgentHosts, "models").mockReturnValue(
    ErrAsync({ reason: "host_unavailable", detail: "host missing" } as const),
  );
  const log = spyOn(console, "log").mockImplementation(() => {});
  const error = spyOn(console, "error").mockImplementation(() => {});
  const paths = OperatorHome.resolve(
    Environment.parse({
      HOME: "/isolated",
      XDG_CONFIG_HOME: "/isolated/config",
      XDG_STATE_HOME: "/isolated/state",
    }),
  );
  expect(await runProfiles(["host", "models", "--host", "opencode"], paths, false)).toBe(true);
  expect(log).not.toHaveBeenCalled();
  expect(error).toHaveBeenCalledWith("operator: host missing");
  expect(process.exitCode).toBe(3);
  process.exitCode = 0;
});

const isolated = OperatorHome.resolve(
  Environment.parse({
    HOME: "/isolated",
    XDG_CONFIG_HOME: "/isolated/config",
    XDG_STATE_HOME: "/isolated/state",
  }),
);

test("reads host models and prints them as compact JSON or as indented text", async () => {
  const data = { host: "claude-code", models: ["m"] };
  const models = spyOn(AgentHosts, "models").mockReturnValue(OkAsync(data) as never);
  const resolve = spyOn(DeviceSettings, "resolve");
  const log = spyOn(console, "log").mockImplementation(() => {});
  const expected = {
    schemaVersion: 1,
    operation: "host_models",
    outcome: "completed",
    reason: "host_models_read",
    blockers: [],
    data,
  };
  process.exitCode = 7;
  expect(
    await runProfiles(["host", "models", "--host", "claude-code", "--json"], isolated, true),
  ).toBe(true);
  expect(models).toHaveBeenCalledWith({ host: "claude-code", cwd: process.cwd() });
  expect(log).toHaveBeenLastCalledWith(JSON.stringify(expected));
  expect(process.exitCode).toBe(0);
  expect(await runProfiles(["host", "models", "--host", "claude-code"], isolated, false)).toBe(
    true,
  );
  expect(log).toHaveBeenLastCalledWith(JSON.stringify(expected, null, 2));
  expect(resolve).not.toHaveBeenCalled();
});

test("resolves a launch with only the given overrides", async () => {
  const resolve = spyOn(DeviceSettings, "resolve").mockReturnValue(
    OkAsync({ host: "opencode" }) as never,
  );
  const models = spyOn(AgentHosts, "models");
  const log = spyOn(console, "log").mockImplementation(() => {});
  const cwd = process.cwd();
  expect(
    await runProfiles(
      [
        "config",
        "resolve",
        "--host",
        "opencode",
        "--role",
        "workerAgent",
        "--profile",
        "deep",
        "--model",
        "m1",
        "--effort",
        "high",
      ],
      isolated,
      true,
    ),
  ).toBe(true);
  expect(resolve).toHaveBeenLastCalledWith({
    paths: isolated,
    cwd,
    role: "workerAgent",
    profile: "deep",
    overrides: { host: "opencode", model: "m1", reasoningEffort: "high" },
  });
  expect(log).toHaveBeenLastCalledWith(
    JSON.stringify({
      schemaVersion: 1,
      operation: "config_resolve",
      outcome: "completed",
      reason: "launch_resolved",
      blockers: [],
      data: { host: "opencode" },
    }),
  );
  expect(await runProfiles(["config", "resolve"], isolated, true)).toBe(true);
  expect(resolve).toHaveBeenLastCalledWith({
    paths: isolated,
    cwd,
    role: undefined,
    profile: undefined,
    overrides: {},
  });
  // Device settings copy every override key, so an absent flag must not add an undefined key.
  expect(resolve.mock.lastCall?.[0].overrides).toStrictEqual({});
  expect(
    await runProfiles(
      ["config", "resolve", "--role", "superAgent", "--model", "m2"],
      isolated,
      true,
    ),
  ).toBe(true);
  expect(resolve.mock.lastCall?.[0].role).toBe("superAgent");
  expect(resolve.mock.lastCall?.[0].overrides).toStrictEqual({ model: "m2" });
  expect(models).not.toHaveBeenCalled();
});

test("rejects host model flags that only launch resolution takes", async () => {
  const models = spyOn(AgentHosts, "models");
  const resolve = spyOn(DeviceSettings, "resolve");
  for (const args of [
    ["host", "models", "--host", "opencode", "--model", "m"],
    ["host", "list", "--host", "opencode"],
    ["config", "models", "--host", "opencode"],
    ["host", "resolve"],
    ["config", "resolve", "--role", "other"],
    ["config", "resolve", "--model", ""],
    ["config", "resolve", "--effort", ""],
    ["config", "resolve", "host", "opencode"],
    ["config", "resolve", "--model", "--json"],
    ["host", "resolve", "--host", "opencode"],
    ["config", "resolve", "xxhost", "opencode"],
  ])
    expect(await runProfiles(args, isolated, true)).toBe(false);
  expect(models).not.toHaveBeenCalled();
  expect(resolve).not.toHaveBeenCalled();
});

test("reports a settings refusal and a host defect with their exit codes", async () => {
  const resolve = spyOn(DeviceSettings, "resolve").mockReturnValue(
    ErrAsync({ reason: "invalid_settings", detail: "bad file" }) as never,
  );
  const log = spyOn(console, "log").mockImplementation(() => {});
  const error = spyOn(console, "error").mockImplementation(() => {});
  expect(await runProfiles(["config", "resolve"], isolated, true)).toBe(true);
  expect(JSON.parse(String(log.mock.lastCall?.[0]))).toMatchObject({
    operation: "config_resolve",
    reason: "invalid_settings",
  });
  expect(error).toHaveBeenLastCalledWith("operator: bad file");
  expect(process.exitCode).toBe(2);
  resolve.mockReturnValue(fromSafePromise(() => Promise.reject(new Error("boom"))) as never);
  expect(await runProfiles(["config", "resolve"], isolated, true)).toBe(true);
  expect(JSON.parse(String(log.mock.lastCall?.[0]))).toMatchObject({
    operation: "config_resolve",
    reason: "host_defect",
  });
  expect(error).toHaveBeenLastCalledWith("operator: Error: boom");
  expect(process.exitCode).toBe(1);
  process.exitCode = 0;
});
