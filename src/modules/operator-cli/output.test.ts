import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { failure, respond } from "./output.ts";
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
