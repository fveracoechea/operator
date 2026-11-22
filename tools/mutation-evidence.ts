// Bun has no atomic rename or synchronous persistence API.
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { MutationEvent } from "./mutation-run.ts";

export function mutationEvidence(
  root: string,
  machine: boolean | undefined,
  output: { log: (line: string) => void; error: (line: string) => void },
  event: MutationEvent,
): void {
  const file = path.join(root, ".mutation-runs", `${event.runId}.json`);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(`${file}.tmp`, JSON.stringify(event));
  renameSync(`${file}.tmp`, file);
  const { state } = event;
  const unrun = state.units.filter((unit) => unit.status === "unrun").length;
  const interrupted = state.units.filter((unit) => unit.status === "interrupted").length;
  const completed = state.units.reduce((sum, unit) => sum + unit.progress.completed, 0);
  const reused = state.units.reduce((sum, unit) => sum + unit.progress.reused, 0);
  const total = state.units.some((unit) => unit.progress.total === null)
    ? "unknown"
    : String(state.units.reduce((sum, unit) => sum + Number(unit.progress.total), 0));
  output.error(
    `Mutation run ${event.runId}: ${event.type}, ${state.status}, ${state.completedUnits}/${state.units.length} completed, active ${state.activeUnit ?? "none"}, ${event.elapsedMs}ms elapsed, ${unrun} unrun, ${interrupted} interrupted, ${completed} mutations completed, total ${total}, ${reused} reused. Evidence: ${file}`,
  );
  if (event.type === "run-started" || event.type === "run-completed")
    output.error(
      `Mutation units: ${state.units.map((unit) => `${unit.name} (${unit.status})`).join(", ")}`,
    );
  if (machine) output.log(JSON.stringify(event));
}
