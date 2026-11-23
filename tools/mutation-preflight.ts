import type { MutationUnit } from "./mutation-selection.ts";
import { initialMutationRun, type MutationEvent, type MutationResult } from "./mutation-run.ts";
import type { MutationProgress } from "./mutation-engine-progress.ts";
import { mutationEstimate } from "./mutation-plan.ts";
import type { mutationReuseDecision } from "./mutation-reuse.ts";

export async function runMutationPreflight(
  selected: { units: MutationUnit[]; skipped: number },
  execute: (
    unit: MutationUnit,
    progress: (progress: MutationProgress) => void,
  ) => Promise<MutationResult[]>,
  runId: string,
  event: (event: MutationEvent) => void,
  reuse?: (unit: MutationUnit) => ReturnType<typeof mutationReuseDecision>,
): Promise<number> {
  const started = Date.now();
  let sequence = 0;
  const { work, state } = initialMutationRun(selected);
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
      evidence.reuse = (await reuse?.(unit))?.decision;
      if (evidence.reuse) publish("reuse-decision");
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
