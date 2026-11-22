import type { MutationUnit } from "./mutation-selection.ts";

export function mutationEstimate(baselineMs: number | null, mutationCount: number | null) {
  if (baselineMs === null || mutationCount === null)
    return { estimatedMs: null, assumptions: ["Baseline timing or mutation count is unknown."] };
  return {
    estimatedMs: baselineMs * (mutationCount + 1),
    assumptions: [
      "One baseline plus one full test-suite duration per mutant, sequential execution, no reuse, no startup or instrumentation overhead. Bailout and timeout behavior may change actual cost.",
    ],
  };
}

export function mutationPlan(selected: { units: MutationUnit[]; skipped: number }) {
  return {
    version: 1,
    type: "selection-plan",
    skipped: selected.skipped,
    selectedUnits: selected.units.length,
    selectedTestFiles: new Set(selected.units.flatMap((unit) => unit.tests)).size,
    testFileExecutionsPerSweep: selected.units.reduce((sum, unit) => sum + unit.tests.length, 0),
    units: selected.units.map(({ name, patterns, tests }) => ({
      name,
      patterns,
      tests,
      testFiles: tests.length,
    })),
    mutationCount: null,
    baselineMs: null,
    estimatedMs: null,
    assumptions: [
      "Test-file counts are exact. Test-case counts and mutation totals are unknown until execution.",
    ],
  };
}

export function printMutationPlan(
  selected: { units: MutationUnit[]; skipped: number },
  machine: boolean,
): void {
  const plan = mutationPlan(selected);
  if (machine) console.log(JSON.stringify(plan));
  else {
    console.error(
      `Mutation selection: ${plan.selectedUnits} units, ${plan.selectedTestFiles} distinct test files, ${plan.testFileExecutionsPerSweep} test-file executions per full mutation sweep.`,
    );
    for (const unit of plan.units)
      console.error(
        `${unit.name}: ${unit.patterns.join(", ")}, ${unit.testFiles} selected test files.`,
      );
    console.error(
      "Baseline, mutation count, and cost: unknown. Use --preflight to measure baselines. No tests executed by this plan.",
    );
  }
}
