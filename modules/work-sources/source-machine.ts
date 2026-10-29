import { Err, Ok, type Result } from "unthrown";
import type { AssignmentState } from "./assignment-machine.ts";

export type SourceState = "open" | "finished" | "reset";
type Facts = { state: SourceState; assignments: AssignmentState[] };
// A reset source stays reset. Any other source finishes once all its work is complete.
const rules: { when: (facts: Facts) => boolean; state: SourceState }[] = [
  { when: ({ state }) => state === "reset", state: "reset" },
  {
    when: ({ assignments }) => assignments.every(complete),
    state: "finished",
  },
];

/** Merged PR work and completed report work are complete. */
export function complete(assignment: AssignmentState) {
  return assignment.completion === "pr"
    ? assignment.state === "merged"
    : assignment.state === "completed";
}

export function decideSource(facts: Facts): SourceState {
  return rules.find((rule) => rule.when(facts))?.state ?? facts.state;
}

type Refusal = {
  reason: "source_ended" | "source_worker_running";
  detail: string;
};

/**
 * The person's instruction ends an open source. Completed work stays as it is, and every other
 * assignment is abandoned. The decision names no worktree, branch, pane, or tracker effect.
 */
export function decideReset(facts: {
  state: string;
  assignments: AssignmentState[];
  /** Running launches, and starting launches whose owner is still alive. */
  workers: { assignment: string; paneId: string | null }[];
}): Result<{ abandon: string[] }, Refusal> {
  if (facts.state !== "open")
    return Err({
      reason: "source_ended",
      detail: `The source is already ${facts.state}. Nothing changed.`,
    });
  if (facts.workers.length > 0)
    return Err({
      reason: "source_worker_running",
      detail: `A worker is still running for ${facts.workers.map(({ assignment, paneId }) => `${assignment} (pane ${paneId ?? "not created yet"})`).join(", ")}. Close each worker pane in Herdr, so that the Operator Herdr plugin records its end, then reset again. Run operator herdr install first when the plugin is missing or from another release. Nothing changed.`,
    });
  return Ok({
    abandon: facts.assignments
      .filter((assignment) => !complete(assignment) && assignment.state !== "abandoned")
      .map((assignment) => assignment.key),
  });
}

export const retentionMs = 14 * 24 * 60 * 60 * 1000;

export type PruneDecision =
  | { prune: true; prunableAt: string }
  | {
      prune: false;
      prunableAt: string | null;
      reason:
        | "source_open"
        | "retention_pending"
        | "end_time_invalid"
        | "cleanup_open"
        | "worker_running";
    };

/**
 * An ended source is deleted once 14 days have passed since its end. A cleanup that is not done
 * or a worker that still runs keeps the records, because they are the only home of that obligation.
 */
export function decidePrune(facts: {
  state: string;
  endedAt: string | null;
  now: number;
  cleanupOpen: boolean;
  workerRunning: boolean;
}): PruneDecision {
  if (facts.state === "open" || facts.endedAt === null)
    return { prune: false, prunableAt: null, reason: "source_open" };
  const ended = Date.parse(facts.endedAt);
  if (Number.isNaN(ended)) return { prune: false, prunableAt: null, reason: "end_time_invalid" };
  const prunableAt = new Date(ended + retentionMs).toISOString();
  if (facts.now < ended + retentionMs)
    return { prune: false, prunableAt, reason: "retention_pending" };
  if (facts.cleanupOpen) return { prune: false, prunableAt, reason: "cleanup_open" };
  if (facts.workerRunning) return { prune: false, prunableAt, reason: "worker_running" };
  return { prune: true, prunableAt };
}
