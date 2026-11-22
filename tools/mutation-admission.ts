import type { MutationEvent } from "./mutation-run.ts";

export function mutationWorkerExitCode(event: MutationEvent | undefined, code: number): number {
  if (event?.type !== "run-completed") return 3;
  return code === 0 && event.state.status !== "passed" ? 3 : code;
}

export function completeMutationEvent(
  event: MutationEvent,
  interrupted: boolean,
  current: boolean | null,
  identity: string,
  elapsedMs: number,
): MutationEvent {
  const completed = structuredClone(event);
  completed.sequence += event.type === "run-completed" ? 0 : 1;
  completed.type = "run-completed";
  completed.elapsedMs = Math.max(event.elapsedMs, elapsedMs);
  completed.admission = { identity, current };
  if (interrupted || !current || event.type !== "run-completed") {
    completed.state.status = "incomplete";
    completed.state.activeUnit = null;
    for (const unit of completed.state.units)
      if (unit.status === "running") unit.status = "interrupted";
    completed.admission.reason = interrupted
      ? "cancelled"
      : !current
        ? "inputs-changed"
        : "worker-incomplete";
  }
  return completed;
}
