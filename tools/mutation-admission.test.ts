import { expect, test } from "bun:test";
import type { MutationEvent } from "./mutation-run.ts";
import { completeMutationEvent, mutationWorkerExitCode } from "./mutation-admission.ts";

const event: MutationEvent = {
  version: 1,
  runId: "owned",
  sequence: 4,
  type: "progress",
  elapsedMs: 50,
  state: {
    status: "running",
    activeUnit: "active.ts",
    completedUnits: 1,
    skipped: 2,
    units: [
      {
        name: "done.ts",
        tests: ["done.test.ts"],
        patterns: ["done.ts"],
        status: "passed",
        mutants: [
          {
            id: "1",
            status: "Killed",
            mutatorName: "ArithmeticOperator",
            replacement: "n - 1",
            location: { start: { line: 1, column: 1 }, end: { line: 1, column: 6 } },
          },
        ],
        progress: { completed: 1, total: 1, reused: 0 },
      },
      {
        name: "active.ts",
        tests: ["active.test.ts"],
        patterns: ["active.ts"],
        status: "running",
        mutants: null,
        progress: { completed: 0, total: null, reused: 0 },
      },
      {
        name: "later.ts",
        tests: ["later.test.ts"],
        patterns: ["later.ts"],
        status: "unrun",
        mutants: null,
        progress: { completed: 0, total: null, reused: 0 },
      },
    ],
  },
};

test("cancellation preserves completed evidence, interrupts active work, and leaves later work unrun", () => {
  const completed = completeMutationEvent(event, true, true, "snapshot", 100);
  expect(completed).toMatchObject({
    version: 1,
    runId: "owned",
    sequence: 5,
    type: "run-completed",
    elapsedMs: 100,
    admission: { identity: "snapshot", current: true, reason: "cancelled" },
    state: { status: "incomplete", activeUnit: null, completedUnits: 1, skipped: 2 },
  });
  expect(completed.state.units.map((unit) => unit.status)).toEqual([
    "passed",
    "interrupted",
    "unrun",
  ]);
  expect(completed.state.units[0]).toEqual(event.state.units[0]);
  expect(event.type).toBe("progress");
  expect(event.sequence).toBe(4);
  expect(event.state.activeUnit).toBe("active.ts");
  expect(event.state.units[1]?.status).toBe("running");
});

test("a worker that disappears without its terminal event cannot qualify even unchanged inputs", () => {
  const completed = completeMutationEvent(event, false, true, "snapshot", 10);
  expect(completed.state.status).toBe("incomplete");
  expect(completed.admission).toEqual({
    identity: "snapshot",
    current: true,
    reason: "worker-incomplete",
  });
  expect(completed.elapsedMs).toBe(50);
});

test.each(["passed", "failed", "incomplete"] as const)(
  "matching terminal inputs preserve an honest %s verdict",
  (status) => {
    const terminal: MutationEvent = {
      ...event,
      type: "run-completed",
      sequence: 8,
      elapsedMs: 500,
      state: { ...event.state, status, activeUnit: null, units: event.state.units.slice(0, 1) },
    };
    const completed = completeMutationEvent(terminal, false, true, "snapshot", 10);
    expect(completed.sequence).toBe(8);
    expect(completed.elapsedMs).toBe(500);
    expect(completed.state).toEqual(terminal.state);
    expect(completed.admission).toEqual({ identity: "snapshot", current: true });
    const stale = completeMutationEvent(terminal, false, false, "snapshot", 600);
    expect(stale.state.status).toBe("incomplete");
    expect(stale.admission).toEqual({
      identity: "snapshot",
      current: false,
      reason: "inputs-changed",
    });
    expect(stale.state.units).toEqual(terminal.state.units);
  },
);

test("owner loss records unknown current inputs rather than asserting a candidate match", () => {
  const completed = completeMutationEvent(event, true, null, "snapshot", 100);
  expect(completed.admission).toEqual({ identity: "snapshot", current: null, reason: "cancelled" });
  expect(completed.state.status).toBe("incomplete");
});

test("budget expiry overrides even a finished passing worker without discarding evidence", () => {
  const terminal: MutationEvent = {
    ...event,
    type: "run-completed",
    state: { ...event.state, status: "passed" },
  };
  const completed = completeMutationEvent(
    terminal,
    false,
    true,
    "snapshot",
    100,
    "budget-exhausted",
  );
  expect(completed.state.status).toBe("incomplete");
  expect(completed.admission).toEqual({
    identity: "snapshot",
    current: true,
    reason: "budget-exhausted",
  });
  expect(completed.state.units[0]).toEqual(terminal.state.units[0]);
});

test("a zero process exit without terminal evidence is incomplete, and real verdict codes remain unchanged", () => {
  expect(mutationWorkerExitCode(undefined, 0)).toBe(3);
  expect(mutationWorkerExitCode(event, 0)).toBe(3);
  const terminal: MutationEvent = {
    ...event,
    type: "run-completed",
    state: { ...event.state, status: "passed" },
  };
  expect(mutationWorkerExitCode(terminal, 0)).toBe(0);
  expect(mutationWorkerExitCode(terminal, 2)).toBe(2);
  expect(mutationWorkerExitCode(terminal, 3)).toBe(3);
  expect(
    mutationWorkerExitCode({ ...terminal, state: { ...terminal.state, status: "failed" } }, 2),
  ).toBe(2);
  expect(mutationWorkerExitCode(completeMutationEvent(event, true, null, "snapshot", 100), 0)).toBe(
    3,
  );
});
