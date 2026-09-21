import { eq } from "drizzle-orm";
import type { CrewReader, CrewWriter } from "./database.ts";
import type { ReworkReason } from "./rework-input.ts";
import { reworkCycles } from "./schema.ts";

export type ReworkCycleRow = typeof reworkCycles.$inferSelect;

/**
 * Three delegated correction rounds on one assignment, and two diagnostic reruns.
 * A correction round changes the result, so it is the one that can loop. A diagnostic rerun
 * changes nothing, so it is bounded more tightly and counted on its own.
 */
export const REWORK_CYCLE_LIMIT = 3;
export const DIAGNOSTIC_RERUN_LIMIT = 2;

/** The limit one reason is counted against. Correction work shares a single budget. */
export type LimitKind = "rework_cycles" | "diagnostic_reruns" | "review_attempts";

export function limitKindOf(reason: string): LimitKind {
  return reason === "diagnostic" ? "diagnostic_reruns" : "rework_cycles";
}

export function limitOf(reason: string): number {
  return reason === "diagnostic" ? DIAGNOSTIC_RERUN_LIMIT : REWORK_CYCLE_LIMIT;
}

export function cyclesOf(db: CrewReader, assignmentId: string): ReworkCycleRow[] {
  return db
    .select()
    .from(reworkCycles)
    .where(eq(reworkCycles.assignmentId, assignmentId))
    .all()
    .toSorted((left, right) => left.cycleIndex - right.cycleIndex);
}

/** The cycle this assignment still owes a result for. One assignment holds at most one. */
export function openCycleOf(db: CrewReader, assignmentId: string): ReworkCycleRow | null {
  return cyclesOf(db, assignmentId).find((one) => one.state === "open") ?? null;
}

/** How many cycles already used the budget one reason is counted against. */
export function cyclesUsed(cycles: ReworkCycleRow[], reason: string): number {
  const kind = limitKindOf(reason);
  return cycles.filter((one) => limitKindOf(one.reason) === kind).length;
}

export function insertCycle(
  db: CrewWriter,
  request: {
    cycleId: string;
    assignmentId: string;
    submissionId: string;
    reviewId: string | null;
    reason: ReworkReason;
    cycleIndex: number;
    brief: unknown;
    briefIdentity: string;
    approvalId: string | null;
    now: string;
  },
): void {
  db.insert(reworkCycles)
    .values({
      id: request.cycleId,
      assignmentId: request.assignmentId,
      submissionId: request.submissionId,
      reviewId: request.reviewId,
      reason: request.reason,
      cycleIndex: request.cycleIndex,
      brief: JSON.stringify(request.brief),
      briefIdentity: request.briefIdentity,
      attemptId: null,
      approvalId: request.approvalId,
      state: "open",
      openedAt: request.now,
      updatedAt: request.now,
    })
    .run();
}

/**
 * Closes one cycle against the attempt that handed over its combined revision.
 * The cycle names that attempt, so the record shows which fresh Operative did the rework.
 */
export function closeCycle(
  db: CrewWriter,
  request: { cycle: ReworkCycleRow; attemptId: string; now: string },
): void {
  db.update(reworkCycles)
    .set({ state: "submitted", attemptId: request.attemptId, updatedAt: request.now })
    .where(eq(reworkCycles.id, request.cycle.id))
    .run();
}
