import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { ErrAsync, fromSafePromise, OkAsync } from "unthrown";
import { Environment } from "../environment/main.ts";
import { OperatorHome } from "../operator-home/main.ts";
import { WorkerDispatch } from "../worker-dispatch/main.ts";
import { WorkSources } from "../work-sources/main.ts";
import { askArgs, runAsk } from "./ask.ts";

const paths = OperatorHome.resolve(
  Environment.parse({
    HOME: "/isolated",
    XDG_CONFIG_HOME: "/isolated/config",
    XDG_STATE_HOME: "/isolated/state",
  }),
);
const source = { id: "question-1", assignments: [{ key: "why-the-queue" }] };

afterEach(() => {
  mock.restore();
  process.exitCode = 0;
});

test("parses question files, stdin, and named profiles in either flag order", () => {
  expect(askArgs(["ask", "--file", "question.txt"])).toEqual({
    file: "question.txt",
    profile: undefined,
  });
  expect(askArgs(["ask", "--json", "--profile", "careful-2", "--file", "-"])).toEqual({
    file: "-",
    profile: "careful-2",
  });
  expect(askArgs(["ask", "--file", "question.txt", "--profile", "a"])).toEqual({
    file: "question.txt",
    profile: "a",
  });
});

test.each([
  [[]],
  [["dispatch", "--file", "question.txt"]],
  [["ask"]],
  [["ask", "--file"]],
  [["ask", "--file", ""]],
  [["ask", "--file", " \n\t"]],
  [["ask", "--file", "--profile"]],
  [["ask", "--file", "a", "--file", "b"]],
  [["ask", "--file", "a", "--profile", "careful", "--profile", "other"]],
  [["ask", "--file", "a", "--profile"]],
  [["ask", "--file", "a", "--json", "--json"]],
  [["ask", "--file", "a", "--source", "s"]],
  [["ask", "extra", "--file", "a"]],
  [["ask", "--question", "inline"]],
])("refuses invalid question arguments %j before registration or launch", async (args) => {
  const ask = spyOn(WorkSources, "ask").mockReturnValue(OkAsync(source) as never);
  const dispatch = spyOn(WorkerDispatch, "dispatch").mockReturnValue(OkAsync({}) as never);
  const log = spyOn(console, "log").mockImplementation(() => {});
  expect(askArgs(args)).toBeNull();
  expect(await runAsk(args, paths, true)).toBe(false);
  expect(ask).not.toHaveBeenCalled();
  expect(dispatch).not.toHaveBeenCalled();
  expect(log).not.toHaveBeenCalled();
});

test.each([
  "",
  "Bad Name",
  "Careful",
  "1careful",
  "-careful",
  "careful_2",
  "careful!",
  "careful\n",
])("refuses invalid profile %j without registering or launching", async (profile) => {
  const ask = spyOn(WorkSources, "ask").mockReturnValue(OkAsync(source) as never);
  const dispatch = spyOn(WorkerDispatch, "dispatch").mockReturnValue(OkAsync({}) as never);
  const args = ["ask", "--file", "-", "--profile", profile];
  expect(askArgs(args)).toBeNull();
  expect(await runAsk(args, paths, true)).toBe(false);
  expect(ask).not.toHaveBeenCalled();
  expect(dispatch).not.toHaveBeenCalled();
});

test.each([true, false])(
  "registers the question before launching and reports it with json=%s",
  async (json) => {
    const ask = spyOn(WorkSources, "ask").mockReturnValue(OkAsync(source) as never);
    const data = { sourceId: "question-1", assignment: "why-the-queue", paneId: "pane-2" };
    const dispatch = spyOn(WorkerDispatch, "dispatch").mockImplementation(() => {
      expect(ask).toHaveBeenCalledTimes(1);
      expect(ask).toHaveBeenCalledWith({
        paths,
        cwd: process.cwd(),
        file: "-",
        profile: "careful",
      });
      return OkAsync(data) as never;
    });
    const log = spyOn(console, "log").mockImplementation(() => {});
    process.exitCode = 7;
    expect(await runAsk(["ask", "--file", "-", "--profile", "careful"], paths, json)).toBe(true);
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch).toHaveBeenCalledWith({
      paths,
      cwd: process.cwd(),
      sourceId: "question-1",
      assignment: "why-the-queue",
    });
    expect(log).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith(
      JSON.stringify(
        {
          schemaVersion: 1,
          operation: "ask",
          outcome: "completed",
          reason: "question_dispatched",
          blockers: [],
          data,
        },
        null,
        json ? undefined : 2,
      ),
    );
    expect(process.exitCode).toBe(0);
  },
);

test.each([
  ["invalid_source_plan", 2],
  ["source_profile_missing", 3],
  ["source_io_failed", 1],
])("question registration refusal %s exits %d without a launch", async (reason, code) => {
  const refusal = {
    reason,
    detail: "Cannot read the question.",
    next: { command: "operator ask --file question.txt", why: "Supply the question." },
    state: { inputValid: false },
  };
  spyOn(WorkSources, "ask").mockReturnValue(ErrAsync(refusal) as never);
  const dispatch = spyOn(WorkerDispatch, "dispatch").mockReturnValue(OkAsync({}) as never);
  const log = spyOn(console, "log").mockImplementation(() => {});
  spyOn(console, "error").mockImplementation(() => {});
  expect(await runAsk(["ask", "--file", "question.txt"], paths, true)).toBe(true);
  expect(dispatch).not.toHaveBeenCalled();
  expect(JSON.parse(String(log.mock.lastCall?.[0]))).toMatchObject({
    operation: "ask",
    reason,
    blockers: [{ reason, detail: refusal.detail }],
    next: refusal.next,
    state: refusal.state,
  });
  expect(process.exitCode).toBe(code);
});

test("a failed question launch preserves recovery facts and names the ordinary dispatch retry", async () => {
  spyOn(WorkSources, "ask").mockReturnValue(OkAsync(source) as never);
  const refusal = {
    reason: "herdr_failed",
    detail: "Plugin unavailable.",
    next: { decider: "super-agent", question: "Inspect the failed command?" },
    state: { exitCode: 1 },
  };
  spyOn(WorkerDispatch, "dispatch").mockReturnValue(ErrAsync(refusal) as never);
  const log = spyOn(console, "log").mockImplementation(() => {});
  spyOn(console, "error").mockImplementation(() => {});
  expect(await runAsk(["ask", "--file", "-"], paths, true)).toBe(true);
  expect(JSON.parse(String(log.mock.lastCall?.[0]))).toMatchObject({
    operation: "ask",
    reason: "herdr_failed",
    next: refusal.next,
    state: refusal.state,
    blockers: [
      {
        reason: "herdr_failed",
        detail:
          "Plugin unavailable. Source question-1 holds the question. Run operator dispatch --source question-1 --assignment why-the-queue again.",
      },
    ],
  });
  expect(process.exitCode).toBe(1);
});

test("question registration defects use the ask defect result without launching", async () => {
  spyOn(WorkSources, "ask").mockReturnValue(
    fromSafePromise(() => Promise.reject(new Error("question defect"))),
  );
  const dispatch = spyOn(WorkerDispatch, "dispatch").mockReturnValue(OkAsync({}) as never);
  const log = spyOn(console, "log").mockImplementation(() => {});
  spyOn(console, "error").mockImplementation(() => {});
  expect(await runAsk(["ask", "--file", "-"], paths, true)).toBe(true);
  expect(dispatch).not.toHaveBeenCalled();
  expect(JSON.parse(String(log.mock.lastCall?.[0]))).toMatchObject({
    operation: "ask",
    reason: "ask_defect",
    blockers: [{ reason: "ask_defect", detail: "Error: question defect" }],
  });
  expect(process.exitCode).toBe(1);
});
