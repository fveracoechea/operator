import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { Err, fromThrowable, Ok } from "unthrown";
import { z } from "zod";
import { DeviceState } from "../device-state/main.ts";
import { Environment } from "../environment/main.ts";
import { OperatorHome } from "../operator-home/main.ts";
import { OperatorRelease } from "../operator-release/main.ts";
import { startup } from "./startup.ts";

const environment = Environment.parse({
  HOME: "/isolated",
  XDG_CONFIG_HOME: "/isolated/config",
  XDG_STATE_HOME: "/isolated/state",
});
const paths = OperatorHome.resolve(environment);
const injected = new Error("injected");

afterEach(() => {
  mock.restore();
  process.exitCode = 0;
});

function capture() {
  process.exitCode = 9;
  return {
    log: spyOn(console, "log").mockImplementation(() => {}),
    error: spyOn(console, "error").mockImplementation(() => {}),
  };
}

function lines(spy: ReturnType<typeof capture>["log"]) {
  return spy.mock.calls.map(([line]) => z.unknown().parse(JSON.parse(String(line))));
}

function release(supportedBun: string) {
  const manifest = {
    version: "9.9.9",
    supportedBun,
    commit: "abc",
    artifactIdentity: "sha256:1",
    builtAt: null,
  };
  spyOn(OperatorRelease, "manifest").mockResolvedValue(manifest);
  return manifest;
}

function compatibility(result: ReturnType<typeof DeviceState.checkCompatibility>) {
  return spyOn(DeviceState, "checkCompatibility").mockReturnValue(result);
}

function defect() {
  return fromThrowable(
    () => {
      // oxlint-disable-next-line unthrown/no-throw -- Inject a defect at a module interface.
      throw injected;
    },
    (cause, fail) => fail(cause),
  )();
}

test("returns the paths and release when every startup check passes", async () => {
  spyOn(Environment, "read").mockReturnValue(environment);
  const manifest = release(">=1");
  const checked = compatibility(Ok(undefined));
  const output = capture();
  expect(await startup(["ready"], true)).toEqual({ paths, release: manifest });
  expect(checked).toHaveBeenCalledWith(paths, false);
  expect(output.log).not.toHaveBeenCalled();
  expect(output.error).not.toHaveBeenCalled();
  expect(process.exitCode).toBe(9);
});

test("only project registration may create device state", async () => {
  spyOn(Environment, "read").mockReturnValue(environment);
  release(">=1");
  const checked = compatibility(Ok(undefined));
  await startup(["project", "register", "--json"], true);
  expect(checked).toHaveBeenCalledWith(paths, true);
});

test("an invalid environment is an invalid startup", async () => {
  spyOn(Environment, "read").mockImplementation(() => Environment.parse({}));
  const manifest = spyOn(OperatorRelease, "manifest");
  const output = capture();
  expect(await startup(["ready"], true)).toBeNull();
  expect(lines(output.log)).toEqual([
    expect.objectContaining({
      operation: "startup",
      outcome: "invalid",
      reason: "invalid_environment",
    }),
  ]);
  expect(process.exitCode).toBe(2);
  expect(manifest).not.toHaveBeenCalled();
});

test("an unexpected path failure is a startup defect", async () => {
  spyOn(Environment, "read").mockImplementation(() => {
    // oxlint-disable-next-line unthrown/no-throw -- Inject a defect at a module interface.
    throw injected;
  });
  const output = capture();
  expect(await startup(["ready"], true)).toBeNull();
  expect(lines(output.log)).toEqual([
    expect.objectContaining({
      operation: "startup",
      reason: "startup_defect",
      blockers: [expect.anything()],
    }),
  ]);
  expect(output.error).toHaveBeenCalledWith("operator: Error: injected");
  expect(process.exitCode).toBe(1);
});

test.each([true, false])("an unsupported Bun stops startup, json %p", async (json) => {
  spyOn(Environment, "read").mockReturnValue(environment);
  release("<1");
  const checked = compatibility(Ok(undefined));
  const output = capture();
  expect(await startup(["ready"], json)).toBeNull();
  expect(lines(output.log)).toEqual(
    json
      ? [
          {
            schemaVersion: 1,
            operation: "startup",
            outcome: "failed",
            reason: "unsupported_bun",
            blockers: [{ reason: "unsupported_bun", required: "<1", actual: Bun.version }],
          },
        ]
      : [],
  );
  expect(output.error).toHaveBeenCalledWith(expect.stringContaining("<1"));
  expect(process.exitCode).toBe(1);
  expect(checked).not.toHaveBeenCalled();
});

test("an incompatible state stops startup with its own exit code", async () => {
  spyOn(Environment, "read").mockReturnValue(environment);
  release(">=1");
  compatibility(Err({ reason: "state_missing", detail: "No state." }) as never);
  const output = capture();
  expect(await startup(["ready"], true)).toBeNull();
  expect(lines(output.log)).toEqual([
    expect.objectContaining({
      operation: "startup",
      reason: "state_missing",
      blockers: [{ reason: "state_missing", detail: "No state." }],
    }),
  ]);
  expect(process.exitCode).toBe(3);
});

test("a compatibility defect is a startup defect", async () => {
  spyOn(Environment, "read").mockReturnValue(environment);
  release(">=1");
  compatibility(defect() as never);
  const output = capture();
  expect(await startup(["ready"], true)).toBeNull();
  expect(lines(output.log)).toEqual([
    expect.objectContaining({ operation: "startup", reason: "startup_defect" }),
  ]);
  expect(output.error).toHaveBeenCalledWith("operator: Error: injected");
  expect(process.exitCode).toBe(1);
});

test("a Herdr event without state ends startup before the compatibility check", async () => {
  spyOn(Environment, "read").mockReturnValue(environment);
  release(">=1");
  const checked = compatibility(Ok(undefined));
  const output = capture();
  expect(await startup(["herdr", "event", "--json"], true)).toBeNull();
  expect(lines(output.log)).toEqual([expect.objectContaining({ reason: "herdr_event_ignored" })]);
  expect(checked).not.toHaveBeenCalled();
});
