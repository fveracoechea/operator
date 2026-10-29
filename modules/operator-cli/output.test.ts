import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { failure } from "./output.ts";

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
