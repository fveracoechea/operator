import { expect, test } from "bun:test";
import { Ok } from "unthrown";
import { decidePrune, decideReset, decideSource, retentionMs } from "./source-machine.ts";

test("an empty source and a mixed completed source finish, but active or abandoned work does not", () => {
  expect(decideSource({ state: "open", assignments: [] })).toBe("finished");
  expect(
    decideSource({
      state: "open",
      assignments: [
        { key: "pr", completion: "pr", state: "merged" },
        { key: "report", completion: "report", state: "completed" },
      ],
    }),
  ).toBe("finished");
  for (const state of ["ready", "running", "reported", "abandoned"] as const)
    expect(
      decideSource({
        state: "open",
        assignments: [{ key: "report", completion: "report", state }],
      }),
    ).toBe("open");
  expect(
    decideSource({
      state: "open",
      assignments: [{ key: "pr", completion: "pr", state: "pr-open" }],
    }),
  ).toBe("open");
});
test("ended source states are stable on repeated reads", () => {
  expect(decideSource({ state: "reset", assignments: [] })).toBe("reset");
  expect(decideSource({ state: "finished", assignments: [] })).toBe("finished");
});

test("reset abandons every incomplete assignment of both completion types and keeps completed work", () => {
  expect(
    decideReset({
      state: "open",
      workers: [],
      assignments: [
        { key: "merged", completion: "pr", state: "merged" },
        { key: "completed", completion: "report", state: "completed" },
        { key: "open", completion: "pr", state: "pr-open" },
        { key: "ready-pr", completion: "pr", state: "ready" },
        { key: "reported", completion: "report", state: "reported" },
        { key: "running", completion: "report", state: "running" },
        { key: "abandoned", completion: "report", state: "abandoned" },
      ],
    }),
  ).toEqual(Ok({ abandon: ["open", "ready-pr", "reported", "running"] }));
});
test("reset refuses an ended source and a running worker", () => {
  for (const state of ["finished", "reset"])
    expect(decideReset({ state, workers: [], assignments: [] })).toMatchObject({
      tag: "Err",
      error: { reason: "source_ended", detail: expect.stringContaining(state) as unknown },
    });
  expect(
    decideReset({
      state: "open",
      workers: [
        { assignment: "read", paneId: "w1:p2" },
        { assignment: "write", paneId: null },
      ],
      assignments: [{ key: "read", completion: "report", state: "running" }],
    }),
  ).toMatchObject({
    tag: "Err",
    error: {
      reason: "source_worker_running",
      detail: expect.stringContaining(
        "read (pane w1:p2), write (pane not created yet). Close each worker pane in Herdr",
      ) as unknown,
    },
  });
});
test("prune waits until exactly 14 days after the end", () => {
  const endedAt = "2026-10-01T00:00:00.000Z";
  const end = Date.parse(endedAt);
  const facts = { state: "reset", endedAt, cleanupOpen: false, workerRunning: false };
  const prunableAt = "2026-10-15T00:00:00.000Z";
  expect(decidePrune({ ...facts, now: end + retentionMs - 1 })).toEqual({
    prune: false,
    prunableAt,
    reason: "retention_pending",
  });
  expect(decidePrune({ ...facts, now: end + retentionMs })).toEqual({ prune: true, prunableAt });
  expect(decidePrune({ ...facts, now: end + retentionMs + 1 })).toEqual({
    prune: true,
    prunableAt,
  });
  expect(decidePrune({ ...facts, state: "finished", now: end + retentionMs })).toEqual({
    prune: true,
    prunableAt,
  });
});
test("prune keeps open sources, invalid end times, open cleanup, and running workers", () => {
  const facts = {
    state: "finished",
    endedAt: "2026-10-01T00:00:00.000Z",
    now: Date.parse("2027-01-01"),
  };
  expect(
    decidePrune({ ...facts, state: "open", cleanupOpen: false, workerRunning: false }),
  ).toEqual({
    prune: false,
    prunableAt: null,
    reason: "source_open",
  });
  expect(
    decidePrune({ ...facts, endedAt: null, cleanupOpen: false, workerRunning: false }),
  ).toMatchObject({
    prune: false,
    reason: "source_open",
  });
  expect(
    decidePrune({ ...facts, endedAt: "later", cleanupOpen: false, workerRunning: false }),
  ).toEqual({
    prune: false,
    prunableAt: null,
    reason: "end_time_invalid",
  });
  expect(decidePrune({ ...facts, cleanupOpen: true, workerRunning: true })).toMatchObject({
    prune: false,
    reason: "cleanup_open",
  });
  expect(decidePrune({ ...facts, cleanupOpen: false, workerRunning: true })).toMatchObject({
    prune: false,
    reason: "worker_running",
  });
  // Retention comes first, so a source inside its period reports when it can go.
  expect(
    decidePrune({
      ...facts,
      now: Date.parse(facts.endedAt),
      cleanupOpen: true,
      workerRunning: false,
    }),
  ).toMatchObject({ reason: "retention_pending" });
});
