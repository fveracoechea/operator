import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { fromPromise } from "unthrown";
import { Environment } from "../environment/main.ts";
import { OperatorHome } from "../operator-home/main.ts";
import { OpenCodePlugin } from "../opencode-plugin/main.ts";
import { runOpenCodeHook } from "./opencode.ts";

const paths = OperatorHome.resolve(
  Environment.parse({ HOME: "/isolated/opencode-hook", NODE_ENV: "test" }),
);
afterEach(() => {
  mock.restore();
  process.exitCode = 0;
});

test("an invalid OpenCode event retains the owner's recovery and checked facts without stdout", async () => {
  spyOn(Bun.stdin, "text").mockResolvedValue("not JSON");
  const log = spyOn(console, "log").mockImplementation(() => {});
  const error = spyOn(console, "error").mockImplementation(() => {});
  expect(await runOpenCodeHook(["opencode", "hook"], paths)).toBe(true);
  expect(error.mock.calls.map(([line]) => String(line))).toEqual([
    "operator: opencode_hook_event_invalid: The OpenCode plugin did not describe a hook event.",
    "next: super-agent decides: Which valid OpenCode plugin event should this invocation receive?",
    "state: eventValid=false",
  ]);
  expect(log).not.toHaveBeenCalled();
  expect(process.exitCode).toBe(1);
});

test("an OpenCode hook defect names a supervisor decision with no fabricated state", async () => {
  spyOn(Bun.stdin, "text").mockResolvedValue("event");
  spyOn(OpenCodePlugin, "answer").mockReturnValue(
    fromPromise(Promise.reject(new Error("injected")), (cause, defect) => defect(cause)),
  );
  const log = spyOn(console, "log").mockImplementation(() => {});
  const error = spyOn(console, "error").mockImplementation(() => {});
  expect(await runOpenCodeHook(["opencode", "hook"], paths)).toBe(true);
  expect(error.mock.calls.map(([line]) => String(line))).toEqual([
    "operator: opencode_hook_defect: Error: injected",
    "next: super-agent decides: How should opencode_hook_defect be corrected before retrying opencode_hook?",
  ]);
  expect(log).not.toHaveBeenCalled();
  expect(process.exitCode).toBe(1);
});
