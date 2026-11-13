import { afterEach, expect, mock, spyOn, test } from "bun:test";
// Bun has no platform temporary-root API.
import { tmpdir } from "node:os";
import { ErrAsync, fromSafePromise, OkAsync } from "unthrown";
import { Environment } from "../environment/main.ts";
import { OperatorHome } from "../operator-home/main.ts";
import { Readiness } from "../readiness/main.ts";
import { runReadiness } from "./readiness.ts";

const paths = OperatorHome.resolve(
  Environment.parse({ HOME: `${tmpdir()}/unused-ready-parser`, NODE_ENV: "test" }),
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

test("unsupported readiness flags refuse before any observation", async () => {
  const check = spyOn(Readiness, "check");
  for (const args of [
    ["other"],
    ["ready", "--json", "--json"],
    ["ready", "--probe"],
    ["ready", "--host", "opencode"],
  ])
    expect(await runReadiness(args, paths, true)).toBe(false);
  expect(check).not.toHaveBeenCalled();
});

test("reports a ready device as compact JSON or as indented text", async () => {
  const check = spyOn(Readiness, "check").mockReturnValue(OkAsync({ blockers: [] }) as never);
  const { log } = quiet();
  const expected = {
    schemaVersion: 1,
    operation: "ready",
    outcome: "completed",
    reason: "ready",
    blockers: [],
    data: { staticOnly: true },
  };
  process.exitCode = 7;
  expect(await runReadiness(["ready", "--json"], paths, true)).toBe(true);
  expect(check).toHaveBeenCalledWith(paths);
  expect(log).toHaveBeenLastCalledWith(JSON.stringify(expected));
  expect(process.exitCode).toBe(0);
  expect(await runReadiness(["ready"], paths, false)).toBe(true);
  expect(log).toHaveBeenLastCalledWith(JSON.stringify(expected, null, 2));
});

test("reports readiness blockers with exit code 3", async () => {
  const blockers = [{ reason: "executable_missing", tool: "herdr", detail: "missing" }];
  spyOn(Readiness, "check").mockReturnValue(OkAsync({ blockers }) as never);
  const { log } = quiet();
  expect(await runReadiness(["ready"], paths, true)).toBe(true);
  expect(log).toHaveBeenLastCalledWith(
    JSON.stringify({
      schemaVersion: 1,
      operation: "ready",
      outcome: "blocked",
      reason: "not_ready",
      blockers,
      data: { staticOnly: true },
    }),
  );
  expect(process.exitCode).toBe(3);
});

test("reports a readiness refusal and a defect with exit code 1", async () => {
  const check = spyOn(Readiness, "check").mockReturnValue(
    ErrAsync({ reason: "state_io_failed", detail: "unreadable" }) as never,
  );
  const { log, error } = quiet();
  expect(await runReadiness(["ready"], paths, true)).toBe(true);
  expect(JSON.parse(String(log.mock.lastCall?.[0]))).toMatchObject({
    operation: "ready",
    reason: "state_io_failed",
  });
  expect(error).toHaveBeenLastCalledWith("operator: unreadable");
  expect(process.exitCode).toBe(1);
  check.mockReturnValue(fromSafePromise(() => Promise.reject(new Error("boom"))) as never);
  process.exitCode = 0;
  expect(await runReadiness(["ready"], paths, true)).toBe(true);
  expect(JSON.parse(String(log.mock.lastCall?.[0]))).toMatchObject({
    operation: "ready",
    reason: "readiness_defect",
  });
  expect(error).toHaveBeenLastCalledWith("operator: Error: boom");
  expect(process.exitCode).toBe(1);
});
