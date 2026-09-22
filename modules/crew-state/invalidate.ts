import { eq } from "drizzle-orm";
import { z } from "zod";
import type { AssignmentRow } from "./assignment.ts";
import type { CrewReader, CrewWriter } from "./database.ts";
import { readAssignment } from "./assignment.ts";
import { assignmentDependencies, assignments, invalidations } from "./schema.ts";
import { readStored } from "./stored.ts";
import { latestSubmission } from "./submission.ts";

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
 */
const CONSUMED = new Set(["claimed", "awaiting-review", "rework", "accepted", "paused"]);

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
  | { status: "not-accepted"; assignmentId: string; state: string };

/** Every open invalidation that named one assignment as a dependent that consumed the result. */
export function invalidationsAffecting(db: CrewReader, assignmentId: string): InvalidationRow[] {
  return db
    .select()
    .from(invalidations)
    .all()
    .filter(
      (one) =>
        one.state === "open" &&
        storedDependents(one.dependents).some(
          (dep) => dep.paused && dep.assignmentId === assignmentId,
        ),
    );
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
function consumingDependents(db: CrewReader, assignmentId: string): AssignmentRow[] {
  const found = new Map<string, AssignmentRow>();
  const queue = [assignmentId];

  while (queue.length > 0) {
    const next = queue.shift();
    if (next === undefined) {
      continue;
    }

    for (const row of directDependents(db, next)) {
      if (found.has(row.id) || !CONSUMED.has(row.state)) {
        continue;
      }

      found.set(row.id, row);
      queue.push(row.id);
    }
  }

  return [...found.values()].toSorted((left, right) => left.id.localeCompare(right.id));
}

function setState(db: CrewWriter, row: AssignmentRow, state: string, now: string): number {
  const revision = row.revision + 1;
  db.update(assignments)
    .set({ state, revision, updatedAt: now })
    .where(eq(assignments.id, row.id))
    .run();
  return revision;
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

  const consuming = consumingDependents(db, row.id);
  const affected = consuming.map((one) => ({
    assignmentId: one.id,
    title: one.title,
    consumedState: one.state,
    paused: true,
  }));
  for (const one of consuming) {
    setState(db, one, "paused", request.now);
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
    revision: setState(db, row, "invalidated", request.now),
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

  const resumed: string[] = [];
  for (const one of open) {
    for (const held of storedDependents(one.dependents)) {
      const row = readAssignment(db, held.assignmentId);
      if (row === null || row.state !== "paused") {
        continue;
      }

      setState(db, row, resumedState(db, held), request.now);
      resumed.push(row.id);
    }

    db.update(invalidations)
      .set({ state: "resolved", resolvedAt: request.now })
      .where(eq(invalidations.id, one.id))
      .run();
  }

  return resumed;
}
