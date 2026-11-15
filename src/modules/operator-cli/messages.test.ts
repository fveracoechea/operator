import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { ErrAsync, OkAsync } from "unthrown";
import { Environment } from "../environment/main.ts";
import { OperatorHome } from "../operator-home/main.ts";
import { WorkerQuestions } from "../worker-questions/main.ts";
import { messageArgs, runMessages } from "./messages.ts";

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

function completed(reason: string) {
  return OkAsync({ reason, data: { key: "focus" } }) as never;
}

function spies() {
  return {
    send: spyOn(WorkerQuestions, "send").mockReturnValue(completed("message_sent")),
    ring: spyOn(WorkerQuestions, "ring").mockReturnValue(completed("message_rung")),
    close: spyOn(WorkerQuestions, "close").mockReturnValue(completed("message_closed")),
    read: spyOn(WorkerQuestions, "read").mockReturnValue(completed("message_read")),
    acknowledge: spyOn(WorkerQuestions, "acknowledge").mockReturnValue(
      completed("message_acknowledged"),
    ),
  };
}

const none = { file: null, key: "", sourceId: "", assignment: "" };
const assignment = ["--source", "s", "--assignment", "a"];

test("worker commands take no assignment selector, and SuperAgent commands name one", () => {
  expect(
    messageArgs(["message", "send", ...assignment, "--key", "k", "--file", "m.md", "--json"]),
  ).toEqual({
    ...none,
    command: "send",
    sourceId: "s",
    assignment: "a",
    file: "m.md",
    key: "k",
  });
  expect(
    messageArgs(["message", "send", ...assignment, "--text", "Stop.", "--key", "k"]),
  ).toBeNull();
  for (const command of ["ring", "close"] as const)
    expect(messageArgs(["message", command, ...assignment, "--key", "k"])).toEqual({
      ...none,
      command,
      sourceId: "s",
      assignment: "a",
      key: "k",
    });
  expect(messageArgs(["message", "read", "--key", "k"])).toEqual({
    ...none,
    command: "read",
    key: "k",
  });
  expect(messageArgs(["message", "ack", "--key", "k"])).toEqual({
    ...none,
    command: "ack",
    key: "k",
  });
  expect(messageArgs(["message", "ack", "--file", "r.md", "--key", "k"])).toMatchObject({
    file: "r.md",
  });
  for (const args of [
    ["message"],
    ["message", "list"],
    ["question", "read", "--key", "k"],
    ["message", "send", ...assignment],
    ["message", "send", "--file", "m.json"],
    ["message", "send", ...assignment, "--key", "k"],
    ["message", "send", ...assignment, "--text", "Stop."],
    ["message", "send", ...assignment, "--file", "m.md"],
    ["message", "send", ...assignment, "--file", "m.json", "--text", "Stop."],
    ["message", "ack", "--key", "k", "--text", "Done."],
    ["message", "ring", ...assignment],
    ["message", "close", "--key", "k"],
    ["message", "read"],
    ["message", "read", "--key", "k", "--file", "r.md"],
    ["message", "ack", "--key", "--json"],
    ["message", "ack", "--key", "k", "--key", "j"],
  ])
    expect(messageArgs(args)).toBeNull();
});

test("passes each command to the matching message operation", async () => {
  const called = spies();
  const log = spyOn(console, "log").mockImplementation(() => {});
  const cwd = process.cwd();
  for (const command of [
    ["send", ...assignment, "--key", "k", "--file", "m.md"],
    ["ring", ...assignment, "--key", "k"],
    ["close", ...assignment, "--key", "k"],
    ["read", "--key", "k"],
    ["ack", "--key", "k", "--file", "r.md"],
  ]) {
    expect(await runMessages(["message", ...command], paths, true)).toBe(true);
    expect(JSON.parse(String(log.mock.lastCall?.[0]))).toMatchObject({
      operation: `message_${command[0]}`,
      outcome: "completed",
    });
  }
  expect(called.send).toHaveBeenCalledWith({
    paths,
    cwd,
    ...none,
    command: "send",
    sourceId: "s",
    assignment: "a",
    key: "k",
    file: "m.md",
  });
  expect(called.acknowledge).toHaveBeenCalledWith({
    paths,
    cwd,
    ...none,
    command: "ack",
    key: "k",
    file: "r.md",
  });
  for (const spy of Object.values(called)) expect(spy).toHaveBeenCalledTimes(1);
  expect(await runMessages(["message", "list"], paths, true)).toBe(false);
});

test.each([
  ["invalid_message_input", 2],
  ["message_io_failed", 1],
  ["self_steering_refused", 4],
  ["worker_launch_not_found", 4],
  ["worker_pane_required", 4],
  ["message_not_open", 3],
])("a %s refusal exits %d", async (reason, code) => {
  spyOn(WorkerQuestions, "read").mockReturnValue(ErrAsync({ reason, detail: "Refused." }) as never);
  const log = spyOn(console, "log").mockImplementation(() => {});
  spyOn(console, "error").mockImplementation(() => {});
  await runMessages(["message", "read", "--key", "k"], paths, true);
  expect(process.exitCode).toBe(code);
  expect(JSON.parse(String(log.mock.lastCall?.[0]))).toMatchObject({
    operation: "message_read",
    reason,
  });
});
