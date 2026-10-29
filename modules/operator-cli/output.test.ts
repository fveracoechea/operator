import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { failure, settingsExitCodes } from "./output.ts";

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

test("maps each settings refusal to its documented exit code", () => {
  expect(settingsExitCodes).toEqual({
    host_defect: 1,
    host_unavailable: 3,
    host_metadata_failed: 1,
    unsupported_model: 3,
    unsupported_effort: 3,
    profile_missing: 3,
    selection_incomplete: 3,
    invalid_settings: 2,
    invalid_settings_edit: 2,
    settings_io_failed: 1,
    settings_recovery_required: 3,
    settings_plan_required: 3,
    settings_plan_stale: 4,
    settings_external: 3,
    settings_write_unconfirmed: 5,
  });
});
