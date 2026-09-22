import { eq } from "drizzle-orm";
import { z } from "zod";
import { type AssignmentRow, moveAssignment, readAssignment } from "./assignment.ts";
import type { CrewReader, CrewWriter } from "./database.ts";
import { assignmentDependencies, invalidations } from "./schema.ts";
import { readStored } from "./stored.ts";
import { latestSubmission } from "./submission.ts";
import { isReview } from "./work-input.ts";

/** The defect found in an accepted result, in the words of whoever found it. */
export const defectInputSchema = z.strictObject({
  summary: z.string().min(1),
  evidence: z.string().min(1),
  foundBy: z.string().min(1),
});

export type DefectInput = z.infer<typeof defectInputSchema>;

/** One dependent that consumed the invalid result, and the state it was paused from. */
const dependent = z.strictObject({
  assignmentId: z.string(),
  title: z.string(),
  consumedState: z.string(),
  paused: z.boolean(),
});

export type Dependent = z.infer<typeof dependent>;

export function storedDependents(stored: string): Dependent[] {
  return readStored("dependent list", z.array(dependent), stored);
}

export type InvalidationRow = typeof invalidations.$inferSelect;

/**
 * The states that prove one dependent already read the result.
 * Work that is still registered has consumed nothing, so the dependency gate is all it needs.
 * A paused assignment is not one of them: the pause is this workflow's own mark, and what the
 * work was doing before it is what says whether it read anything.
 */
const CONSUMED: ReadonlySet<string> = new Set(["claimed", "awaiting-review", "rework", "accepted"]);

export type InvalidateOutcome =
  | {
      status: "invalidated";
      assignmentId: string;
      revision: number;
      invalidationId: string;
      submissionId: string | null;
      dependents: Dependent[];
    }
  | { status: "unknown-assignment"; assignmentId: string }
  | { status: "stale-revision"; assignmentId: string; recordedRevision: number }
  | { status: "not-accepted"; assignmentId: string; state: string }
  | { status: "review-not-invalidated"; assignmentId: string };

/** Every defect that still holds work. A resolved one is history and holds nothing. */
function openInvalidations(db: CrewReader): InvalidationRow[] {
  return db
    .select()
    .from(invalidations)
    .all()
    .filter((one) => one.state === "open");
}

/**
 * Which invalidated results each paused assignment read.
 * The dependents of an invalidation are stored as one record, so this is read once and asked
 * many times rather than scanned again for every assignment.
 */
export function openPauses(db: CrewReader): Map<string, string[]> {
  const held = new Map<string, string[]>();

  for (const one of openInvalidations(db)) {
    for (const dependent of storedDependents(one.dependents)) {
      if (dependent.paused) {
        held.set(dependent.assignmentId, [
          ...(held.get(dependent.assignmentId) ?? []),
          one.assignmentId,
        ]);
      }
    }
  }

  return held;
}

/**
 * What one dependent was doing before any pause.
 * A second defect can reach work an earlier one already paused, and that work must return to
 * where it really was, never to the pause another invalidation put it in.
 */
function stateBeforePause(db: CrewReader, row: AssignmentRow): string {
  if (row.state !== "paused") {
    return row.state;
  }

  for (const one of openInvalidations(db)) {
    const held = storedDependents(one.dependents).find(
      (dependent) => dependent.paused && dependent.assignmentId === row.id,
    );
    if (held !== undefined) {
      return held.consumedState;
    }
  }

  return row.state;
}

function directDependents(db: CrewReader, assignmentId: string): AssignmentRow[] {
  return db
    .select()
    .from(assignmentDependencies)
    .where(eq(assignmentDependencies.dependsOnId, assignmentId))
    .all()
    .flatMap((edge) => {
      const row = readAssignment(db, edge.assignmentId);
      return row === null ? [] : [row];
    });
}

/**
 * The dependents that read the invalid result, directly or through another that read it.
 * The walk follows only work that consumed something, so an unstarted dependent stops it.
 */
function consumingDependents(db: CrewReader, assignmentId: string): Dependent[] {
  const found = new Map<string, Dependent>();
  const queue = [assignmentId];

  while (queue.length > 0) {
    const next = queue.shift();
    if (next === undefined) {
      continue;
    }

    for (const row of directDependents(db, next)) {
      const consumedState = stateBeforePause(db, row);
      if (found.has(row.id) || !CONSUMED.has(consumedState)) {
        continue;
      }

      found.set(row.id, {
        assignmentId: row.id,
        title: row.title,
        consumedState,
        paused: true,
      });
      queue.push(row.id);
    }
  }

  return [...found.values()].toSorted((left, right) =>
    left.assignmentId.localeCompare(right.assignmentId),
  );
}

/**
 * Records a defect found in an accepted result.
 * The acceptance, its submission, its review, and every finding stay exactly as they were,
 * because that history is what says which dependents read the invalid result. Only the work
 * that actually consumed it is paused; work that never started is held by the dependency gate.
 */
export function invalidateResult(
  db: CrewWriter,
  request: {
    invalidationId: string;
    assignmentId: string;
    revision: number;
    input: DefectInput;
    now: string;
  },
): InvalidateOutcome {
  const row = readAssignment(db, request.assignmentId);
  if (row === null) {
    return { status: "unknown-assignment", assignmentId: request.assignmentId };
  }
  if (row.revision !== request.revision) {
    return { status: "stale-revision", assignmentId: row.id, recordedRevision: row.revision };
  }
  if (row.state !== "accepted") {
    return { status: "not-accepted", assignmentId: row.id, state: row.state };
  }
  // A review carries no result of its own. A review that read the work wrongly is answered by
  // reviewing that work again, so returning a review assignment to the frontier settles nothing.
  if (isReview(row.kind)) {
    return { status: "review-not-invalidated", assignmentId: row.id };
  }

  const affected = consumingDependents(db, row.id);
  for (const one of affected) {
    const dependent = readAssignment(db, one.assignmentId);
    if (dependent !== null && dependent.state !== "paused") {
      moveAssignment(db, { row: dependent, state: "paused", now: request.now });
    }
  }

  const submission = latestSubmission(db, row.id);
  db.insert(invalidations)
    .values({
      id: request.invalidationId,
      assignmentId: row.id,
      submissionId: submission?.id ?? null,
      defect: JSON.stringify(request.input),
      dependents: JSON.stringify(affected),
      state: "open",
      recordedAt: request.now,
      resolvedAt: null,
    })
    .run();

  return {
    status: "invalidated",
    assignmentId: row.id,
    revision: moveAssignment(db, { row, state: "invalidated", now: request.now }),
    invalidationId: request.invalidationId,
    submissionId: submission?.id ?? null,
    dependents: affected,
  };
}

/**
 * The state one paused dependent returns to.
 * Work that was accepted returns to the step that decided it, because an acceptance that read
 * an invalid input is a decision to take again, not a state to carry over.
 */
function resumedState(db: CrewReader, held: Dependent): string {
  if (held.consumedState !== "accepted") {
    return held.consumedState;
  }

  return latestSubmission(db, held.assignmentId) === null ? "registered" : "awaiting-review";
}

/**
 * Releases the work one invalidated assignment held, now that a corrected result is accepted.
 * A dependent returns to the state it was paused from, and an accepted one to the step that
 * decided it, so its acceptance is decided again against the corrected input.
 */
export function resolveInvalidations(
  db: CrewWriter,
  request: { assignmentId: string; now: string },
): string[] {
  const open = db
    .select()
    .from(invalidations)
    .where(eq(invalidations.assignmentId, request.assignmentId))
    .all()
    .filter((one) => one.state === "open");

  // The defects this result answers close first, so what is still held is read from the rest.
  for (const one of open) {
    db.update(invalidations)
      .set({ state: "resolved", resolvedAt: request.now })
      .where(eq(invalidations.id, one.id))
      .run();
  }

  const stillHeld = openPauses(db);
  const resumed: string[] = [];
  for (const one of open) {
    for (const held of storedDependents(one.dependents)) {
      const row = readAssignment(db, held.assignmentId);
      // Work that also read another invalid result keeps waiting for that correction.
      if (row === null || row.state !== "paused" || stillHeld.has(held.assignmentId)) {
        continue;
      }

      moveAssignment(db, { row, state: resumedState(db, held), now: request.now });
      resumed.push(row.id);
    }
  }

  return resumed;
}
