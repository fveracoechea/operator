import { eq } from "drizzle-orm";
import { z } from "zod";
import type { CrewReader, CrewWriter } from "./database.ts";
import { type ReworkReason, storedReworkReason } from "./rework-input.ts";
import { reworkCycles } from "./schema.ts";
import { readStoredValue } from "./stored.ts";

export type ReworkCycleRow = typeof reworkCycles.$inferSelect;

/**
 * Three delegated correction rounds on one assignment, and two diagnostic reruns.
 * A correction round changes the result, so it is the one that can loop. A diagnostic rerun
 * changes nothing, so it is bounded more tightly and counted on its own.
 */
export const REWORK_CYCLE_LIMIT = 3;
export const DIAGNOSTIC_RERUN_LIMIT = 2;

/** The limit one reason is counted against. Correction work shares a single budget. */
export const limitKindSchema = z.enum(["rework_cycles", "diagnostic_reruns", "review_attempts"]);

export type LimitKind = z.infer<typeof limitKindSchema>;

// A direction request stores this column, and every reader takes it back through the schema
// that wrote it rather than asserting the kind it expected.
export function storedLimitKind(stored: string): LimitKind {
  return readStoredValue("limit kind", limitKindSchema, stored);
}

export type Budget = { kind: LimitKind; limit: number };

const CORRECTION: Budget = { kind: "rework_cycles", limit: REWORK_CYCLE_LIMIT };

/**
 * The budget one reason spends.
 * A findings cycle and an integration cycle both change the result, so they share one budget.
 * A diagnostic rerun changes nothing and carries its own.
 */
export function budgetOf(reason: ReworkReason): Budget {
  return reason === "diagnostic"
    ? { kind: "diagnostic_reruns", limit: DIAGNOSTIC_RERUN_LIMIT }
    : CORRECTION;
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

/** How many cycles already spent the budget one reason is counted against. */
export function cyclesUsed(cycles: ReworkCycleRow[], reason: ReworkReason): number {
  const { kind } = budgetOf(reason);
  return cycles.filter((one) => budgetOf(storedReworkReason(one.reason)).kind === kind).length;
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
