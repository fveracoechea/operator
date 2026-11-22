import type { MutationUnit } from "./mutation-selection.ts";
import type { MutationEvent, MutationResult } from "./mutation-run.ts";
import type { MutationProgress } from "./mutation-engine-progress.ts";
import { mutationEstimate } from "./mutation-plan.ts";

export async function runMutationPreflight(
  selected: { units: MutationUnit[]; skipped: number },
  execute: (
    unit: MutationUnit,
    progress: (progress: MutationProgress) => void,
  ) => Promise<MutationResult[]>,
  runId: string,
  event: (event: MutationEvent) => void,
): Promise<number> {
  const started = Date.now();
  let sequence = 0;
  const work = selected.units.map<{
    unit: MutationUnit;
    evidence: MutationEvent["state"]["units"][number];
  }>((unit) => ({
    unit,
    evidence: {
      name: unit.name,
      tests: unit.tests,
      patterns: unit.patterns,
      status: "unrun",
      mutants: null,
      progress: { completed: 0, total: null, reused: 0 },
    },
  }));
  const state: MutationEvent["state"] = {
    status: "running",
    activeUnit: null,
    completedUnits: 0,
    skipped: selected.skipped,
    units: work.map(({ evidence }) => evidence),
  };
  function publish(type: MutationEvent["type"]) {
    event({
      version: 1,
      mode: "preflight",
      runId,
      sequence: sequence++,
      type,
      elapsedMs: Date.now() - started,
      state: structuredClone(state),
    });
  }

  publish("run-started");
  for (const { unit, evidence } of work) {
    evidence.status = "running";
    evidence.preflight = {
      baselineMs: null,
      overheadMs: null,
      mutationCount: null,
      ...mutationEstimate(null, null),
    };
    state.activeUnit = unit.name;
    publish("unit-started");
    try {
      if (unit.tests.length === 0) {
        evidence.error = "No direct beside-tests.";
        evidence.status = "interrupted";
        publish("unit-interrupted");
        break;
      }
      await execute(unit, (progress) => {
        evidence.preflight = {
          baselineMs: progress.baselineMs ?? null,
          overheadMs: progress.overheadMs ?? null,
          mutationCount: progress.total,
          ...mutationEstimate(progress.baselineMs ?? null, progress.total),
        };
        publish("progress");
      });
      evidence.status = "unrun";
      console.error(
        `${unit.name}: measured preflight baseline ${evidence.preflight.baselineMs ?? "unknown"}ms, overhead ${evidence.preflight.overheadMs ?? "unknown"}ms, mutation count ${evidence.preflight.mutationCount ?? "unknown"}, estimated cost ${evidence.preflight.estimatedMs ?? "unknown"}ms. Baseline-only evidence, not mutation qualification. Assumptions: ${evidence.preflight.assumptions.join()}`,
      );
      publish("unit-completed");
    } catch (error) {
      evidence.status = "interrupted";
      evidence.error = String(error);
      publish("unit-interrupted");
      break;
    }
  }
  state.status = "incomplete";
  state.activeUnit = null;
  publish("run-completed");
  return 3;
}
