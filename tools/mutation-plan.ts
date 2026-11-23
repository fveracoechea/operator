import type { MutationUnit } from "./mutation-selection.ts";
import { z } from "zod";

const correctionProof = z.object({
  owner: z.string(),
  tests: z.array(z.string()),
  evidence: z.enum(["assertion-failure", "engine-verdict"]),
});

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

export function mutationPlan(
  selected: { units: MutationUnit[]; skipped: number },
  proof?: z.infer<typeof correctionProof>,
) {
  const owner = proof && selected.units.find((unit) => unit.name === proof.owner);
  const ownerTestsMatch =
    owner !== undefined &&
    owner.tests.length > 0 &&
    JSON.stringify(owner.tests) === JSON.stringify(proof?.tests);
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
    proof: proof
      ? {
          ...proof,
          ownerTestsMatch,
          status: ownerTestsMatch ? "matching-owner-tests" : "insufficient-owner-tests",
        }
      : undefined,
  };
}

export async function printMutationPlan(
  selected: { units: MutationUnit[]; skipped: number },
  machine: boolean,
  proofFile?: string,
): Promise<0 | 1> {
  let proof: z.infer<typeof correctionProof> | undefined;
  if (proofFile !== undefined) {
    try {
      proof = correctionProof.parse(await Bun.file(proofFile).json());
    } catch {
      console.error(
        "Correction proof needs an owner, exact selected tests, and assertion-failure or engine-verdict evidence.",
      );
      return 1;
    }
  }
  const plan = mutationPlan(selected, proof);
  if (machine) console.log(JSON.stringify(plan));
  else {
    console.error(
      `Mutation selection: ${plan.selectedUnits} units, ${plan.selectedTestFiles} distinct test files, ${plan.testFileExecutionsPerSweep} test-file executions per full mutation sweep.`,
    );
    for (const unit of plan.units)
      console.error(
        `${unit.name}: ${unit.patterns.join(", ")}, ${unit.testFiles} selected test files: ${unit.tests.join(", ")}.`,
      );
    console.error(
      "Baseline, mutation count, and cost: unknown. Use --preflight to measure baselines. No tests executed by this plan.",
    );
    if (plan.proof)
      console.error(
        `${plan.proof.owner}: ${plan.proof.status}, ${plan.proof.evidence}. Matching files alone do not establish assertion adequacy or an engine verdict.`,
      );
  }
  return plan.proof && !plan.proof.ownerTestsMatch ? 1 : 0;
}
