import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { ErrAsync } from "unthrown";
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
