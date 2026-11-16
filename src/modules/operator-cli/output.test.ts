import { afterEach, expect, mock, spyOn, test } from "bun:test";
import {
  failure,
  printRefusal,
  respond,
  outputContext,
  withOutputContext,
  printWorkerContext,
} from "./output.ts";
import { Err, Ok } from "unthrown";

afterEach(() => {
  mock.restore();
  process.exitCode = 0;
});

test("emits a machine-readable refusal only when JSON is selected", () => {
  const log = spyOn(console, "log").mockImplementation(() => {});
  const error = spyOn(console, "error").mockImplementation(() => {});
  const context = {
    next: { command: "operator host models --host opencode", why: "Choose an advertised effort." },
  };
  failure("config_resolve", "unsupported_effort", "unsupported", 3, true, context);
  expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toEqual({
    schemaVersion: 1,
    operation: "config_resolve",
    outcome: "refused",
    reason: "unsupported_effort",
    blockers: [{ reason: "unsupported_effort", detail: "unsupported" }],
    ...context,
  });
  expect(error).toHaveBeenCalledWith("operator: unsupported_effort: unsupported");
  expect(error).toHaveBeenCalledWith("next: operator host models --host opencode");
  expect(process.exitCode).toBe(3);
  log.mockClear();
  failure("config_resolve", "unsupported_effort", "unsupported", 3, false, context);
  expect(log).not.toHaveBeenCalled();
});

test("marks invalid input separately from a refused operation", () => {
  const log = spyOn(console, "log").mockImplementation(() => {});
  spyOn(console, "error").mockImplementation(() => {});
  failure("config_plan", "invalid_settings_edit", "bad input", 2, true, {
    next: { command: "operator --help", why: "Correct the edit syntax." },
  });
  expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toMatchObject({ outcome: "invalid" });
  expect(process.exitCode).toBe(2);
});

test("a compact nonworker refusal with next has no fabricated kind or phase suffix", () => {
  const error = spyOn(console, "error").mockImplementation(() => {});
  failure("command", "guard", "Not ready.", 3, false, {
    next: { command: "operator ready", why: "Check." },
  });
  expect(error.mock.calls.map((call) => String(call[0]))).toEqual([
    "operator: guard: Not ready.",
    "next: operator ready",
  ]);
});

test("plain worker context renders commands, decisions and completion without extra lines", async () => {
  const log = spyOn(console, "log").mockImplementation(() => {});
  printWorkerContext();
  expect(log).not.toHaveBeenCalled();
  for (const { next, line } of [
    { next: { command: "operator next\n--wait", why: "Wait." }, line: "operator next --wait" },
    {
      next: { decider: "super-agent", question: "Accept\nthe report?" },
      line: "super-agent decides: Accept the report?",
    },
    { next: { why: "Nothing\nremains." }, line: "Nothing remains." },
  ] as const) {
    log.mockClear();
    await withOutputContext(
      () => ({ kind: "research", phase: "report", next }),
      async () => printWorkerContext(),
    );
    expect(log.mock.calls).toEqual([["kind: research; phase: report"], [`next: ${line}`]]);
  }
  log.mockClear();
  await withOutputContext(
    () => ({ kind: "research", phase: "report" }),
    async () => printWorkerContext(),
  );
  expect(log.mock.calls).toEqual([["kind: research; phase: report"]]);
});

test("grouped compact refusals include worker identity without replacing blocker recovery", async () => {
  const error = spyOn(console, "error").mockImplementation(() => {});
  await withOutputContext(
    () => ({
      kind: "research",
      phase: "investigate",
      next: { command: "operator report submit --file <file>", why: "Submit." },
    }),
    async () => {
      printRefusal("not_ready", "Missing.", [
        {
          next: { decider: "person", question: "Install?" },
          state: { found: false },
        },
      ]);
    },
  );
  expect(error.mock.calls).toEqual([
    ["operator: not_ready: Missing. [kind=research phase=investigate]"],
    ["next: [1] person decides: Install?"],
    ['state: [1]={"found":false}'],
  ]);
});

test("worker output includes phase defaults without replacing owner authority or checked state", async () => {
  const log = spyOn(console, "log").mockImplementation(() => {});
  const error = spyOn(console, "error").mockImplementation(() => {});
  await withOutputContext(
    () => {
      return {
        kind: "research",
        phase: "investigate",
        next: { command: "operator report submit --file <file>", why: "Submit." },
      };
    },
    async () => {
      respond({
        operation: "question_ask",
        result: Ok({
          reason: "question_asked",
          data: { key: "scope" },
          next: { command: "operator question wait --key scope", why: "Wait." },
          state: { question: "open" },
        }),
        exitCodes: {},
        defect: "defect",
        json: true,
      });
    },
  );
  expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toEqual({
    schemaVersion: 1,
    operation: "question_ask",
    outcome: "completed",
    reason: "question_asked",
    blockers: [],
    data: { key: "scope" },
    kind: "research",
    phase: "investigate",
    next: { command: "operator question wait --key scope", why: "Wait." },
    state: { question: "open" },
  });
  expect(outputContext()).toEqual({});
  expect(error).not.toHaveBeenCalled();
});

test("worker refusals stay within three lines and expose owner next and checked state", async () => {
  const log = spyOn(console, "log").mockImplementation(() => {});
  const error = spyOn(console, "error").mockImplementation(() => {});
  await withOutputContext(
    () => ({
      kind: "review",
      phase: "ready",
      next: { command: "operator pr ready --file <file>", why: "Resolve." },
    }),
    async () => {
      respond({
        operation: "pr_ready",
        result: Err({
          reason: "guard",
          detail: "Not ready.\nNothing changed.",
          next: { decider: "person", question: "Keep the work?" },
          state: { clean: false },
        }),
        exitCodes: { guard: 4 },
        defect: "defect",
        json: true,
      });
    },
  );
  expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toMatchObject({
    kind: "review",
    phase: "ready",
    next: { decider: "person", question: "Keep the work?" },
    state: { clean: false },
  });
  expect(error.mock.calls.map((call) => String(call[0]))).toEqual([
    "operator: guard: Not ready. Nothing changed. [kind=review phase=ready]",
    "next: person decides: Keep the work?",
    "state: clean=false",
  ]);
  expect(process.exitCode).toBe(4);
});

test("worker defaults cover success and defects when the operation has no next", async () => {
  const log = spyOn(console, "log").mockImplementation(() => {});
  spyOn(console, "error").mockImplementation(() => {});
  await withOutputContext(
    () => ({
      kind: "research",
      phase: "report",
      next: { command: "operator report submit --file <file>", why: "Submit." },
    }),
    async () => {
      respond({
        operation: "report_submit",
        result: Ok({ reason: "result", data: {} }),
        exitCodes: {},
        defect: "defect",
        json: true,
      });
      failure("report_submit", "defect", "An I/O operation failed.", 1, true, {
        next: { command: "operator report submit --file <file>", why: "Submit." },
      });
    },
  );
  for (const call of log.mock.calls)
    expect(JSON.parse(String(call[0]))).toMatchObject({
      kind: "research",
      phase: "report",
      next: { command: "operator report submit --file <file>", why: "Submit." },
    });
  expect(log).toHaveBeenCalledTimes(2);
});

test.each([
  { next: { command: "operator next\n--wait", why: "Wait." }, line: "next: operator next --wait" },
  {
    next: { decider: "person", question: "Keep\r\nthe work?" },
    line: "next: person decides: Keep the work?",
  },
  { next: { why: "Nothing\u2028remains.\u2029" }, line: "next: Nothing remains. " },
] as const)("refusal context is JSON data and compact text: $line", ({ next, line }) => {
  const log = spyOn(console, "log").mockImplementation(() => {});
  const error = spyOn(console, "error").mockImplementation(() => {});
  const state = { found: "finished", expected: "open", workers: 0 };
  failure("source_reset", "source_ended", "Finished.\nNothing changed.", 3, true, { next, state });
  expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toStrictEqual({
    schemaVersion: 1,
    operation: "source_reset",
    outcome: "refused",
    reason: "source_ended",
    blockers: [{ reason: "source_ended", detail: "Finished.\nNothing changed." }],
    next,
    state,
  });
  expect(error.mock.calls).toEqual([
    ["operator: source_ended: Finished. Nothing changed."],
    [line],
    ['state: found="finished" expected="open" workers=0'],
  ]);
  expect(process.exitCode).toBe(3);
});

test("respond transports success next and checked state", () => {
  const log = spyOn(console, "log").mockImplementation(() => {});
  const error = spyOn(console, "error").mockImplementation(() => {});
  respond({
    operation: "next",
    result: Ok({
      reason: "next_actions_read",
      data: { sources: [] },
      next: { why: "Nothing remains." },
      state: { sources: 0 },
    }),
    exitCodes: {},
    defect: "source_defect",
    json: true,
  });
  expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toStrictEqual({
    schemaVersion: 1,
    operation: "next",
    outcome: "completed",
    reason: "next_actions_read",
    blockers: [],
    data: { sources: [] },
    next: { why: "Nothing remains." },
    state: { sources: 0 },
  });
  expect(error).not.toHaveBeenCalled();
  expect(process.exitCode).toBe(0);
});

test("respond passes refusal context without inventing unchecked state", () => {
  const log = spyOn(console, "log").mockImplementation(() => {});
  const error = spyOn(console, "error").mockImplementation(() => {});
  respond({
    operation: "source_reset",
    result: Err({
      reason: "source_ended",
      detail: "Finished.",
      next: { why: "Nothing remains." },
    }),
    exitCodes: {},
    defect: "source_defect",
    json: false,
  });
  expect(error.mock.calls).toEqual([
    ["operator: source_ended: Finished."],
    ["next: Nothing remains."],
  ]);
  expect(log).not.toHaveBeenCalled();
  expect(process.exitCode).toBe(3);
});

test("respond reports a defect with the command's decision context and no checked facts", () => {
  const log = spyOn(console, "log").mockImplementation(() => {});
  const error = spyOn(console, "error").mockImplementation(() => {});
  respond({
    operation: "ready",
    result: { tag: "Defect", cause: new Error("injected") },
    exitCodes: {},
    defect: "readiness_defect",
    json: true,
  });
  expect(log.mock.calls).toEqual([
    [
      JSON.stringify({
        schemaVersion: 1,
        operation: "ready",
        outcome: "refused",
        reason: "readiness_defect",
        blockers: [{ reason: "readiness_defect", detail: "Error: injected" }],
        next: {
          decider: "super-agent",
          question: "How should readiness_defect be corrected before retrying ready?",
        },
      }),
    ],
  ]);
  expect(error.mock.calls).toEqual([
    ["operator: readiness_defect: Error: injected"],
    ["next: super-agent decides: How should readiness_defect be corrected before retrying ready?"],
  ]);
  expect(process.exitCode).toBe(1);
});

test("grouped refusals retain indexed decisions and only their owning checked facts", () => {
  const { log, error } = {
    log: spyOn(console, "log").mockImplementation(() => {}),
    error: spyOn(console, "error").mockImplementation(() => {}),
  };
  process.exitCode = 7;
  printRefusal("blocked", "first\nsecond", [
    { next: { command: "operator next\n--wait", why: "Observe the assignment." } },
    { next: { decider: "person", question: "Keep\u2028this?" }, state: { found: false } },
    { next: { why: "Nothing\rleft." }, state: {} },
  ]);
  expect(error.mock.calls).toEqual([
    ["operator: blocked: first second"],
    ["next: [1] operator next --wait; [2] person decides: Keep this?; [3] Nothing left."],
    ['state: [2]={"found":false} [3]={}'],
  ]);
  expect(log).not.toHaveBeenCalled();
  expect(process.exitCode).toBe(7);
  error.mockClear();
  printRefusal("blocked", "no facts", [
    { next: { decider: "super-agent", question: "Which source?" } },
  ]);
  expect(error.mock.calls).toEqual([
    ["operator: blocked: no facts"],
    ["next: [1] super-agent decides: Which source?"],
  ]);
  error.mockClear();
  printRefusal("blocked", "empty checked facts", { next: { why: "Nothing left." }, state: {} });
  expect(error.mock.calls).toEqual([
    ["operator: blocked: empty checked facts"],
    ["next: Nothing left."],
    ["state: "],
  ]);
});
