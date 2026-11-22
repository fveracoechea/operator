export type MutationProgress = {
  completed: number;
  total: number | null;
  reused: number;
  baselineMs?: number;
  overheadMs?: number;
};

// Stryker loads reporter plugins by file name. Execution is deliberately sequential.
let listener: ((progress: MutationProgress) => void) | undefined;

export async function reportMutationProgress<T>(
  notify: (progress: MutationProgress) => void,
  execute: () => Promise<T>,
): Promise<T> {
  listener = notify;
  try {
    return await execute();
  } finally {
    listener = undefined;
  }
}

function createReporter() {
  let completed = 0;
  let total: number | null = null;
  let reused = 0;
  return {
    onDryRunCompleted(event: { timing: { net: number; overhead: number } }) {
      listener?.({
        completed,
        total,
        reused,
        baselineMs: event.timing.net,
        overheadMs: event.timing.overhead,
      });
    },
    onMutationTestingPlanReady(event: {
      mutantPlans: readonly { plan: string; mutant: { status?: string } }[];
    }) {
      total = event.mutantPlans.length;
      reused = event.mutantPlans.filter(
        ({ plan, mutant }) =>
          plan === "EarlyResult" && (mutant.status === "Killed" || mutant.status === "Survived"),
      ).length;
      listener?.({ completed, total, reused });
    },
    onMutantTested() {
      completed++;
      listener?.({ completed, total, reused });
    },
  };
}

export const strykerPlugins = [
  { kind: "Reporter", name: "operator-progress", factory: createReporter },
] as const;
