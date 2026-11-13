import { afterEach, expect, mock, spyOn, test } from "bun:test";
// Bun has no platform temporary-root API.
import { tmpdir } from "node:os";
import { ErrAsync, fromSafePromise, OkAsync } from "unthrown";
import { Environment } from "../environment/main.ts";
import { OperatorHome } from "../operator-home/main.ts";
import { Readiness } from "../readiness/main.ts";
import { runReadiness } from "./readiness.ts";
import { withOutputContext } from "./output.ts";

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
  const check = spyOn(Readiness, "check").mockReturnValue(
    OkAsync({ blockers: [], warnings: [] }) as never,
  );
  const { log, error } = quiet();
  const expected = {
    schemaVersion: 1,
    operation: "ready",
    outcome: "completed",
    reason: "ready",
    blockers: [],
    warnings: [],
    data: { staticOnly: true },
  };
  process.exitCode = 7;
  expect(await runReadiness(["ready", "--json"], paths, true)).toBe(true);
  expect(check).toHaveBeenCalledWith(paths);
  expect(log).toHaveBeenLastCalledWith(JSON.stringify(expected));
  expect(process.exitCode).toBe(0);
  expect(await runReadiness(["ready"], paths, false)).toBe(true);
  expect(log).toHaveBeenLastCalledWith(JSON.stringify(expected, null, 2));
  expect(error).not.toHaveBeenCalled();
});

test("reports readiness blockers with exit code 3", async () => {
  const blockers = [
    {
      reason: "executable_missing",
      tool: "herdr",
      detail: "missing",
      next: { decider: "person", question: "Which installation supplies herdr?" },
      state: { tool: "herdr", executable: null },
    },
  ];
  spyOn(Readiness, "check").mockReturnValue(OkAsync({ blockers, warnings: [] }) as never);
  const { log, error } = quiet();
  expect(await runReadiness(["ready"], paths, true)).toBe(true);
  expect(log).toHaveBeenLastCalledWith(
    JSON.stringify({
      schemaVersion: 1,
      operation: "ready",
      outcome: "blocked",
      reason: "not_ready",
      blockers,
      warnings: [],
      data: { staticOnly: true },
      next: {
        decider: "super-agent",
        question:
          "Which readiness blockers should be resolved next, and which named person decisions must be requested?",
      },
      state: { blockers: ["executable_missing"] },
    }),
  );
  expect(process.exitCode).toBe(3);
  const text = [
    ["operator: not_ready: [1] executable_missing (herdr): missing"],
    ["next: [1] person decides: Which installation supplies herdr?"],
    ['state: [1]={"tool":"herdr","executable":null}'],
  ];
  expect(error.mock.calls).toEqual(text);
  log.mockClear();
  error.mockClear();
  expect(await runReadiness(["ready"], paths, false)).toBe(true);
  expect(log).not.toHaveBeenCalled();
  expect(error.mock.calls).toEqual(text);
});

test("text readiness preserves every owner context without adding absent facts", async () => {
  const blockers = [
    {
      reason: "host_unconfigured" as const,
      detail: "Choose\na host.",
      next: { command: "operator config show", why: "Inspect the selected host." },
    },
    {
      reason: "executable_missing" as const,
      tool: "herdr" as const,
      detail: "Install herdr.",
      next: { decider: "person" as const, question: "Which installation?" },
      state: { tool: "herdr", executable: null },
    },
  ];
  spyOn(Readiness, "check").mockReturnValue(OkAsync({ blockers, warnings: [] }));
  const { log, error } = quiet();
  expect(await runReadiness(["ready"], paths, false)).toBe(true);
  expect(log).not.toHaveBeenCalled();
  expect(error.mock.calls).toEqual([
    [
      "operator: not_ready: [1] host_unconfigured: Choose a host.; [2] executable_missing (herdr): Install herdr.",
    ],
    ["next: [1] operator config show; [2] person decides: Which installation?"],
    ['state: [2]={"tool":"herdr","executable":null}'],
  ]);
  expect(process.exitCode).toBe(3);
});

test("reports a readiness refusal and a defect with exit code 1", async () => {
  const check = spyOn(Readiness, "check").mockReturnValue(
    ErrAsync({
      reason: "state_io_failed",
      detail: "unreadable",
      next: {
        decider: "super-agent",
        question: "How should the isolated state failure be corrected?",
      },
    }) as never,
  );
  const { log, error } = quiet();
  expect(await runReadiness(["ready"], paths, true)).toBe(true);
  expect(JSON.parse(String(log.mock.lastCall?.[0]))).toMatchObject({
    operation: "ready",
    reason: "state_io_failed",
  });
  expect(error).toHaveBeenCalledWith("operator: state_io_failed: unreadable");
  expect(process.exitCode).toBe(1);
  check.mockReturnValue(fromSafePromise(() => Promise.reject(new Error("boom"))) as never);
  process.exitCode = 0;
  expect(await runReadiness(["ready"], paths, true)).toBe(true);
  expect(JSON.parse(String(log.mock.lastCall?.[0]))).toMatchObject({
    operation: "ready",
    reason: "readiness_defect",
    next: {
      decider: "super-agent",
      question: "How should readiness_defect be corrected before retrying ready?",
    },
  });
  expect(error).toHaveBeenCalledWith("operator: readiness_defect: Error: boom");
  expect(process.exitCode).toBe(1);
});

test.each([true, false])(
  "readiness preserves worker phase context when ready is %p",
  async (ready) => {
    spyOn(Readiness, "check").mockReturnValue(
      OkAsync({
        blockers: ready ? [] : [{ reason: "executable_missing", tool: "herdr", detail: "missing" }],
      }) as never,
    );
    const { log } = quiet();
    await withOutputContext(
      ({ operation, reason }) => {
        expect(operation).toBe("ready");
        expect(reason).toBe(ready ? "ready" : "not_ready");
        return {
          kind: "prototype",
          phase: "react",
          next: { command: "operator report submit --file <file>", why: "Submit." },
        };
      },
      async () => {
        await runReadiness(["ready"], paths, true);
      },
    );
    expect(JSON.parse(String(log.mock.lastCall?.[0]))).toMatchObject({
      kind: "prototype",
      phase: "react",
      next: { command: "operator report submit --file <file>", why: "Submit." },
    });
  },
);
