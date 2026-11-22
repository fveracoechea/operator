import { expect, test } from "bun:test";
// Bun has no temporary-directory or recursive-removal API.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { mutationEvidence } from "./mutation-evidence.ts";
import type { MutationEvent } from "./mutation-run.ts";

test("the evidence sink atomically replaces recoverable state and renders human and machine progress", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "operator-mutation-evidence-"));
  const stdout: string[] = [];
  const stderr: string[] = [];
  const event: MutationEvent = {
    version: 1,
    runId: "example",
    sequence: 0,
    type: "progress",
    elapsedMs: 125,
    state: {
      status: "running",
      activeUnit: "active.ts",
      completedUnits: 1,
      skipped: 2,
      units: [
        {
          name: "done.ts",
          patterns: ["done.ts"],
          tests: [],
          status: "passed",
          mutants: [],
          progress: { completed: 3, total: 3, reused: 2 },
        },
        {
          name: "active.ts",
          patterns: ["active.ts"],
          tests: [],
          status: "running",
          mutants: null,
          progress: { completed: 0, total: null, reused: 0 },
        },
        {
          name: "later.ts",
          patterns: ["later.ts"],
          tests: [],
          status: "unrun",
          mutants: null,
          progress: { completed: 0, total: null, reused: 0 },
        },
        {
          name: "broken.ts",
          patterns: ["broken.ts"],
          tests: [],
          status: "interrupted",
          mutants: null,
          progress: { completed: 0, total: null, reused: 0 },
        },
      ],
    },
  };
  const output = {
    log: (line: string) => stdout.push(line),
    error: (line: string) => stderr.push(line),
  };
  try {
    mutationEvidence(root, false, output, event);
    const file = `${root}/.mutation-runs/example.json`;
    expect(await Bun.file(file).json()).toEqual(event);
    expect(await Bun.file(`${file}.tmp`).exists()).toBe(false);
    expect(stdout).toEqual([]);
    expect(stderr[0]).toBe(
      `Mutation run example: progress, running, 1/4 completed, active active.ts, 125ms elapsed, 1 unrun, 1 interrupted, 3 mutations completed, total unknown, 2 reused. Evidence: ${file}`,
    );
    const next = { ...event, sequence: 1, elapsedMs: 250 };
    mutationEvidence(root, true, output, next);
    expect(await Bun.file(file).json()).toEqual(next);
    expect(stdout).toEqual([JSON.stringify(next)]);
    expect(stderr[1]).toContain("250ms elapsed");
    mutationEvidence(root, false, output, {
      ...event,
      type: "run-started",
      state: { ...event.state, units: [] },
    });
    expect(stderr.at(-1)).toBe("Mutation units: ");
    expect(stderr.at(-2)).toContain("0 mutations completed, total 0, 0 reused");
    mutationEvidence(root, false, output, { ...event, type: "run-completed" });
    expect(stderr.at(-1)).toBe(
      "Mutation units: done.ts (passed), active.ts (running), later.ts (unrun), broken.ts (interrupted)",
    );
    mutationEvidence(root, false, output, {
      ...event,
      state: { ...event.state, activeUnit: null, units: event.state.units.slice(0, 1) },
    });
    expect(stderr.at(-1)).toContain("active none");
    expect(stderr.at(-1)).toContain("3 mutations completed, total 3, 2 reused");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
