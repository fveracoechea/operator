import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { ErrAsync, OkAsync } from "unthrown";
import { Environment } from "../environment/main.ts";
import { OperatorHome } from "../operator-home/main.ts";
import { WorkerQuestions } from "../worker-questions/main.ts";
import { questionArgs, runQuestions } from "./questions.ts";

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
  return OkAsync({ reason, data: { key: "scope" } }) as never;
}

function spies() {
  return {
    ask: spyOn(WorkerQuestions, "ask").mockReturnValue(completed("question_asked")),
    wait: spyOn(WorkerQuestions, "wait").mockReturnValue(completed("question_answered")),
    withdraw: spyOn(WorkerQuestions, "withdraw").mockReturnValue(completed("question_withdrawn")),
    escalate: spyOn(WorkerQuestions, "escalate").mockReturnValue(completed("question_escalated")),
    answer: spyOn(WorkerQuestions, "answer").mockReturnValue(completed("question_answered")),
  };
}

const none = {
  file: "",
  key: "",
  sourceId: "",
  assignment: "",
  by: "super-agent" as const,
  timeoutSeconds: 300,
};
const selector = ["--source", "s", "--assignment", "a", "--key", "k"];

test("worker commands take no assignment selector, and SuperAgent commands name one", () => {
  expect(questionArgs(["question", "ask", "--key", "k", "--file", "q.md", "--json"])).toEqual({
    ...none,
    command: "ask",
    file: "q.md",
    key: "k",
  });
  expect(questionArgs(["question", "wait", "--key", "k"])).toEqual({
    ...none,
    command: "wait",
    key: "k",
  });
  expect(questionArgs(["question", "wait", "--timeout", "0", "--key", "k"])).toMatchObject({
    timeoutSeconds: 0,
  });
  expect(questionArgs(["question", "withdraw", "--key", "k"])).toMatchObject({
    command: "withdraw",
    key: "k",
  });
  expect(questionArgs(["question", "escalate", ...selector])).toEqual({
    ...none,
    command: "escalate",
    sourceId: "s",
    assignment: "a",
    key: "k",
  });
  expect(
    questionArgs(["question", "answer", ...selector, "--by", "person", "--file", "a.md"]),
  ).toEqual({
    ...none,
    command: "answer",
    sourceId: "s",
    assignment: "a",
    key: "k",
    by: "person",
    file: "a.md",
  });
  expect(
    questionArgs(["question", "answer", ...selector, "--by", "person", "--text", "No."]),
  ).toBeNull();
  for (const args of [
    ["question"],
    ["question", "ask"],
    ["question", "list"],
    ["other", "ask", "--file", "q.json"],
    ["question", "ask", "--file", "q.md"],
    ["question", "ask", "--file", "--json"],
    ["question", "wait"],
    ["question", "wait", "--key", "k", "--timeout", "-1"],
    ["question", "wait", "--key", "k", "--timeout", "123456"],
    ["question", "wait", "--key", "k", "--timeout"],
    ["question", "withdraw", "--key", "k", "--timeout", "5"],
    ["question", "escalate", "--source", "s", "--assignment", "a"],
    ["question", "answer", ...selector, "--by", "person"],
    ["question", "answer", ...selector, "--by", "person", "--file", "a.md", "--text", "No."],
    ["question", "ask", "--text", "Why?"],
    ["question", "escalate", ...selector, "--key", "j"],
    ["question", "answer", ...selector, "--file", "a.md"],
    ["question", "answer", ...selector, "--by", "worker", "--file", "a.md"],
    ["question", "answer", ...selector, "--by", "person"],
    ["question", "wait", "--key", "k", "--json", "--json"],
  ])
    expect(questionArgs(args)).toBeNull();
});

test("refuses invalid question commands before any question operation", async () => {
  const called = spies();
  for (const args of [
    ["question", "ask"],
    ["question", "close"],
    ["report", "submit"],
  ])
    expect(await runQuestions(args, paths, true)).toBe(false);
  for (const spy of Object.values(called)) expect(spy).not.toHaveBeenCalled();
});

test("passes each command to the matching question operation", async () => {
  const called = spies();
  const { log } = quiet();
  const cwd = process.cwd();
  const commands = [
    ["ask", "--key", "k", "--file", "q.md"],
    ["wait", "--key", "k", "--timeout", "5"],
    ["withdraw", "--key", "k"],
    ["escalate", ...selector],
    ["answer", ...selector, "--by", "person", "--file", "a.md"],
  ];
  for (const command of commands) {
    expect(await runQuestions(["question", ...command], paths, true)).toBe(true);
    expect(JSON.parse(String(log.mock.lastCall?.[0]))).toMatchObject({
      operation: `question_${command[0]}`,
      outcome: "completed",
    });
  }
  expect(called.ask).toHaveBeenCalledWith({
    paths,
    cwd,
    ...none,
    command: "ask",
    key: "k",
    file: "q.md",
  });
  expect(called.wait).toHaveBeenCalledWith({
    paths,
    cwd,
    ...none,
    command: "wait",
    key: "k",
    timeoutSeconds: 5,
  });
  expect(called.answer).toHaveBeenCalledWith({
    paths,
    cwd,
    ...none,
    command: "answer",
    sourceId: "s",
    assignment: "a",
    key: "k",
    by: "person",
    file: "a.md",
  });
  for (const spy of Object.values(called)) expect(spy).toHaveBeenCalledTimes(1);
});

test.each([
  ["invalid_question_input", 2],
  ["question_io_failed", 1],
  ["self_decision_refused", 4],
  ["worker_launch_not_found", 4],
  ["worker_pane_required", 4],
  ["question_not_open", 3],
  ["state_busy", 1],
])("a %s refusal exits %d", async (reason, code) => {
  spyOn(WorkerQuestions, "ask").mockReturnValue(ErrAsync({ reason, detail: "Refused." }) as never);
  const { log } = quiet();
  await runQuestions(["question", "ask", "--key", "k", "--file", "q.md"], paths, true);
  expect(process.exitCode).toBe(code);
  expect(JSON.parse(String(log.mock.lastCall?.[0]))).toMatchObject({
    operation: "question_ask",
    outcome: code === 2 ? "invalid" : "refused",
    reason,
  });
});
