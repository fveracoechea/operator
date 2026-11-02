import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { ErrAsync, fromSafePromise, OkAsync } from "unthrown";
import { ClaudeHook } from "../claude-hook/main.ts";
import { runClaudeHook } from "./claude.ts";

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

test.each([[["claude"]], [["claude", "hook", "--json"]], [["x", "hook"]], [["claude", "x"]]])(
  "leaves other arguments to the other commands: %p",
  async (args) => {
    const answer = spyOn(ClaudeHook, "answer");
    expect(await runClaudeHook(args)).toBe(false);
    expect(answer).not.toHaveBeenCalled();
  },
);

test("answers the event on standard input and exits 0", async () => {
  spyOn(Bun.stdin, "text").mockResolvedValue("event");
  const answer = spyOn(ClaudeHook, "answer").mockReturnValue(OkAsync("deny"));
  const { log } = quiet();
  process.exitCode = 7;
  expect(await runClaudeHook(["claude", "hook"])).toBe(true);
  expect(answer).toHaveBeenCalledWith("event");
  expect(log).toHaveBeenCalledWith("deny");
  expect(process.exitCode).toBe(0);
});

test("an event with no opinion prints nothing", async () => {
  spyOn(Bun.stdin, "text").mockResolvedValue("event");
  spyOn(ClaudeHook, "answer").mockReturnValue(OkAsync(""));
  const { log } = quiet();
  await runClaudeHook(["claude", "hook"]);
  expect(log).not.toHaveBeenCalled();
  expect(process.exitCode).toBe(0);
});

test("a refusal or a defect exits 1 with its reason on standard error", async () => {
  spyOn(Bun.stdin, "text").mockResolvedValue("event");
  const answer = spyOn(ClaudeHook, "answer").mockReturnValue(
    ErrAsync({ reason: "claude_hook_event_invalid", detail: "not an event" }),
  );
  const { log, error } = quiet();
  await runClaudeHook(["claude", "hook"]);
  expect(error).toHaveBeenLastCalledWith("operator: not an event");
  expect(process.exitCode).toBe(1);
  answer.mockReturnValue(
    fromSafePromise(Promise.resolve("")).flatMap(() => {
      // oxlint-disable-next-line unthrown/no-throw -- Inject a defect at the public module boundary.
      throw new Error("broken");
    }),
  );
  process.exitCode = 0;
  await runClaudeHook(["claude", "hook"]);
  expect(error).toHaveBeenLastCalledWith("operator: Error: broken");
  expect(process.exitCode).toBe(1);
  expect(log).not.toHaveBeenCalled();
});
