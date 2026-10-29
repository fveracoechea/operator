import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { ErrAsync, fromSafePromise, OkAsync } from "unthrown";
import { GlobalLauncher } from "../global-launcher/main.ts";
import { runLauncher } from "./launcher.ts";

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

test("refuses other commands and flags before any launcher install", async () => {
  const install = spyOn(GlobalLauncher, "install");
  for (const args of [
    ["other", "launcher"],
    ["install"],
    ["install", "other"],
    ["install", "launcher", "--json", "--json"],
    ["install", "launcher", "--force"],
  ])
    expect(await runLauncher(args, true)).toBe(false);
  expect(install).not.toHaveBeenCalled();
});

test("prints the completed install as compact JSON or as indented text", async () => {
  const data = { command: "/bin/operator", runs: "jsr:@scope/operator@1.0.0" };
  const install = spyOn(GlobalLauncher, "install").mockReturnValue(
    OkAsync({ reason: "launcher_installed" as const, data }),
  );
  const { log } = quiet();
  const expected = {
    schemaVersion: 1,
    operation: "install_launcher",
    outcome: "completed",
    reason: "launcher_installed",
    blockers: [],
    data,
  };
  process.exitCode = 7;
  expect(await runLauncher(["install", "launcher", "--json"], true)).toBe(true);
  expect(log).toHaveBeenLastCalledWith(JSON.stringify(expected));
  expect(process.exitCode).toBe(0);
  expect(await runLauncher(["install", "launcher"], false)).toBe(true);
  expect(log).toHaveBeenLastCalledWith(JSON.stringify(expected, null, 2));
  expect(install).toHaveBeenCalledTimes(2);
});

test.each([
  ["launcher_unsupported", 3],
  ["launcher_version_unpinned", 3],
  ["launcher_bun_failed", 3],
  ["launcher_conflict", 4],
  ["launcher_global_manifest_invalid", 1],
  ["launcher_io_failed", 1],
] as const)("refuses %s with exit code %d", async (reason, code) => {
  spyOn(GlobalLauncher, "install").mockReturnValue(ErrAsync({ reason, detail: "not installed" }));
  const { log, error } = quiet();
  expect(await runLauncher(["install", "launcher", "--json"], true)).toBe(true);
  expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toMatchObject({
    operation: "install_launcher",
    reason,
  });
  expect(error).toHaveBeenCalledWith("operator: not installed");
  expect(process.exitCode).toBe(code);
});

test("reports a launcher defect with exit code 1", async () => {
  spyOn(GlobalLauncher, "install").mockReturnValue(
    fromSafePromise(() => Promise.reject(new Error("boom"))),
  );
  const { log, error } = quiet();
  expect(await runLauncher(["install", "launcher"], true)).toBe(true);
  expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toMatchObject({
    operation: "install_launcher",
    reason: "launcher_defect",
  });
  expect(error).toHaveBeenCalledWith("operator: Error: boom");
  expect(process.exitCode).toBe(1);
});
