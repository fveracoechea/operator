import { afterAll, expect, spyOn, test } from "bun:test";
// Bun has no temporary-directory or recursive removal API.
import { mkdtemp, rm } from "node:fs/promises";
import { mutationPlan, mutationEstimate, printMutationPlan } from "./mutation-plan.ts";

const root = await mkdtemp("/tmp/opencode/450-plan-");
afterAll(async () => rm(root, { recursive: true, force: true }));

test("the human plan shows ranges, test amplification and explicit unknown cost before execution", () => {
  const error = spyOn(console, "error").mockImplementation(() => {});
  const log = spyOn(console, "log").mockImplementation(() => {});
  try {
    printMutationPlan(
      {
        skipped: 0,
        units: [
          {
            name: "a.ts",
            source: "",
            patterns: ["a.ts:2-4", "a.ts:9-9"],
            tests: ["./a.test.ts", "./a.more.test.ts"],
          },
        ],
      },
      false,
    );
    expect(log).not.toHaveBeenCalled();
    expect(error.mock.calls).toEqual([
      [
        "Mutation selection: 1 units, 2 distinct test files, 2 test-file executions per full mutation sweep.",
      ],
      ["a.ts: a.ts:2-4, a.ts:9-9, 2 selected test files."],
      [
        "Baseline, mutation count, and cost: unknown. Use --preflight to measure baselines. No tests executed by this plan.",
      ],
    ]);
  } finally {
    error.mockRestore();
    log.mockRestore();
  }
});

test("planning preserves selected changed ranges and shows repeated test-file amplification", () => {
  const plan = mutationPlan({
    skipped: 2,
    units: [
      {
        name: "a.ts",
        source: "",
        patterns: ["a.ts:2-4"],
        tests: ["./a.test.ts", "./shared.test.ts"],
      },
      { name: "b.ts", source: "", patterns: ["b.ts:9-9"], tests: ["./shared.test.ts"] },
    ],
  });
  expect(plan.skipped).toBe(2);
  expect(plan.selectedUnits).toBe(2);
  expect(plan.selectedTestFiles).toBe(2);
  expect(plan.testFileExecutionsPerSweep).toBe(3);
  expect(plan.units).toEqual([
    {
      name: "a.ts",
      patterns: ["a.ts:2-4"],
      tests: ["./a.test.ts", "./shared.test.ts"],
      testFiles: 2,
    },
    { name: "b.ts", patterns: ["b.ts:9-9"], tests: ["./shared.test.ts"], testFiles: 1 },
  ]);
});

test("cost estimates keep unknowns distinct from zero and identify full-suite assumptions", () => {
  expect(mutationEstimate(null, 4)).toEqual({
    estimatedMs: null,
    assumptions: ["Baseline timing or mutation count is unknown."],
  });
  expect(mutationEstimate(25, null).estimatedMs).toBeNull();
  expect(mutationEstimate(25, 4)).toEqual({
    estimatedMs: 125,
    assumptions: [
      "One baseline plus one full test-suite duration per mutant, sequential execution, no reuse, no startup or instrumentation overhead. Bailout and timeout behavior may change actual cost.",
    ],
  });
  expect(mutationEstimate(25, 0).estimatedMs).toBe(25);
  expect(mutationEstimate(0, 4).estimatedMs).toBe(0);
});

test("selection-only reports ranges and test amplification without executing or admitting inputs", async () => {
  await Bun.write(`${root}/count.ts`, "export const count = 1;\n");
  await Bun.write(`${root}/count.test.ts`, `throw new Error("must not execute");`);
  const child = Bun.spawn(
    [process.execPath, `${import.meta.dir}/mutate.ts`, "--plan", "--json", "count.ts"],
    { cwd: root, stdout: "pipe", stderr: "pipe" },
  );
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  expect(code, stderr).toBe(0);
  expect(JSON.parse(stdout)).toEqual({
    version: 1,
    type: "selection-plan",
    skipped: 0,
    selectedUnits: 1,
    selectedTestFiles: 1,
    testFileExecutionsPerSweep: 1,
    units: [{ name: "count.ts", patterns: ["count.ts"], tests: ["./count.test.ts"], testFiles: 1 }],
    mutationCount: null,
    baselineMs: null,
    estimatedMs: null,
    assumptions: [
      "Test-file counts are exact. Test-case counts and mutation totals are unknown until execution.",
    ],
  });
  expect(await Array.fromAsync(new Bun.Glob(".mutation-*").scan({ cwd: root, dot: true }))).toEqual(
    [],
  );
});
