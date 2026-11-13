import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { failure, respond, outputContext, withOutputContext } from "./output.ts";
import { Err, Ok } from "unthrown";

afterEach(() => {
  mock.restore();
  process.exitCode = 0;
});

test("emits a machine-readable refusal only when JSON is selected", () => {
  const log = spyOn(console, "log").mockImplementation(() => {});
  const error = spyOn(console, "error").mockImplementation(() => {});
  failure("config_resolve", "unsupported_effort", "unsupported", 3, true);
  expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toEqual({
    schemaVersion: 1,
    operation: "config_resolve",
    outcome: "refused",
    reason: "unsupported_effort",
    blockers: [{ reason: "unsupported_effort", detail: "unsupported" }],
  });
  expect(error).toHaveBeenCalledWith("operator: unsupported");
  expect(process.exitCode).toBe(3);
  log.mockClear();
  failure("config_resolve", "unsupported_effort", "unsupported", 3, false);
  expect(log).not.toHaveBeenCalled();
});

test("marks invalid input separately from a refused operation", () => {
  const log = spyOn(console, "log").mockImplementation(() => {});
  spyOn(console, "error").mockImplementation(() => {});
  failure("config_plan", "invalid_settings_edit", "bad input", 2, true);
  expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toMatchObject({ outcome: "invalid" });
  expect(process.exitCode).toBe(2);
});

test("worker output includes phase defaults without replacing owner authority or checked state", async () => {
  const log = spyOn(console, "log").mockImplementation(() => {});
  const error = spyOn(console, "error").mockImplementation(() => {});
  await withOutputContext(
    ({ operation, reason, questionKey }) => {
      expect(operation).toBe("question_ask");
      expect(reason).toBe("question_asked");
      expect(questionKey).toBe("scope");
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
  expect(outputContext("outside", "outside")).toEqual({});
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
      failure("report_submit", "defect", "An I/O operation failed.", 1, true);
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
