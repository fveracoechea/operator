import { eq } from "drizzle-orm";
import { z } from "zod";
import {
  type AssignmentRow,
  type AssignmentState,
  assignmentStateSchema,
  moveAssignment,
  readAssignment,
  storedAssignmentState,
} from "./assignment.ts";
import { Assignment, type AssignmentNext, type InvalidateRefusal } from "./assignment-machine.ts";
import type { CrewReader, CrewWriter } from "./database.ts";
import { assignmentDependencies, invalidations } from "./schema.ts";
import { readStored } from "./stored.ts";
import type { DirectionRecord } from "./direction.ts";
import { defectInputSchema, type DefectInput } from "./rework-input.ts";
import {
  type InvalidationCycle,
  type InvalidationCycleOutcome,
  openInvalidationCycle,
} from "./rework-open.ts";
import { openCycleOf } from "./rework.ts";
import { latestSubmission, readSubmission } from "./submission.ts";
import { currentLandingOf } from "./landing-record.ts";
import { faultsOf, partOfCommit } from "./stack-parts.ts";

/** One dependent that consumed the invalid result, and the state it was paused from. */
const dependent = z.strictObject({
  assignmentId: z.string(),
  title: z.string(),
  consumedState: assignmentStateSchema,
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
const CONSUMED: ReadonlySet<AssignmentState> = new Set<AssignmentState>([
  "claimed",
  "awaiting-review",
  "rework",
  "accepted",
]);

export type InvalidateOutcome =
  | {
      status: "invalidated";
      assignmentId: string;
      revision: number;
      invalidationId: string;
      submissionId: string | null;
      dependents: Dependent[];
      // The cycle the invalidation opened, or null for planning work or a spent budget.
      cycle: InvalidationCycle | null;
      // The direction request a spent budget recorded, or null when the budget allowed a cycle.
      direction: DirectionRecord | null;
    }
  | { status: "unknown-assignment"; assignmentId: string }
  | InvalidateRefusal;

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
function stateBeforePause(db: CrewReader, row: AssignmentRow): AssignmentState {
  const state = storedAssignmentState(row.state);
  if (state !== "paused") {
    return state;
  }

  for (const one of openInvalidations(db)) {
    const held = storedDependents(one.dependents).find(
      (dependent) => dependent.paused && dependent.assignmentId === row.id,
    );
    if (held !== undefined) {
      return held.consumedState;
    }
  }

  return state;
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

/** The merged part that holds the landed commit of one result, or null when none merged. */
function mergedPartOf(db: CrewReader, row: AssignmentRow) {
  const landing = currentLandingOf(db, row.id);
  const part = landing === null ? null : partOfCommit(db, row.sourceId, landing.landedCommit);
  return landing === null || part === null || part.status !== "merged"
    ? null
    : { commit: landing.landedCommit, pullRequest: part.pull.number, url: part.pull.url };
}

/** Pauses each dependent that read the invalid result. Work already paused stays as it is. */
function pauseDependents(db: CrewWriter, request: { affected: Dependent[]; now: string }): void {
  for (const one of request.affected) {
    const row = readAssignment(db, one.assignmentId);
    if (row === null) {
      continue;
    }
    const decided = Assignment.decide("pause", { row });
    if ("next" in decided) {
      moveAssignment(db, { row, next: decided.next, now: request.now });
    }
  }
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
    cycleId: string;
    input: DefectInput;
    now: string;
  },
): InvalidateOutcome {
  const row = readAssignment(db, request.assignmentId);
  if (row === null) {
    return { status: "unknown-assignment", assignmentId: request.assignmentId };
  }
  const decided = Assignment.decide("invalidate", {
    row,
    revision: request.revision,
    merged: mergedPartOf(db, row),
  });
  if ("refused" in decided) {
    return decided.refused;
  }

  const affected = consumingDependents(db, row.id);
  pauseDependents(db, { affected, now: request.now });

  const submission = latestSubmission(db, row.id);
  // Planning work is never dispatched (ADR 0004), so it holds no submission and opens no cycle.
  // It is decided again with a new record (ADR 0019).
  const correction =
    submission === null
      ? null
      : openInvalidationCycle(db, {
          cycleId: request.cycleId,
          assignmentId: row.id,
          invalidationId: request.invalidationId,
          defect: request.input,
          submission,
          now: request.now,
        });
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
    revision: moveAssignment(db, { row, next: decided.next, now: request.now }),
    invalidationId: request.invalidationId,
    submissionId: submission?.id ?? null,
    dependents: affected,
    cycle: correction?.status === "opened" ? correction.cycle : null,
    direction: correction?.status === "limit-reached" ? correction.direction : null,
  };
}

/**
 * Opens the cycle of the open invalidation of one assignment, when that invalidation found the
 * budget spent and the user has directed it since. The claim calls this, so the direction is
 * spent by the work it permits, and the content of the cycle is still what the defect recorded.
 */
export function openDirectedCorrection(
  db: CrewWriter,
  request: { assignmentId: string; cycleId: string; now: string },
): InvalidationCycleOutcome | null {
  const open = openInvalidations(db).find((one) => one.assignmentId === request.assignmentId);
  const submission =
    open === undefined || open.submissionId === null ? null : readSubmission(db, open.submissionId);
  if (open === undefined || submission === null || openCycleOf(db, request.assignmentId) !== null) {
    return null;
  }

  return openInvalidationCycle(db, {
    cycleId: request.cycleId,
    assignmentId: request.assignmentId,
    invalidationId: open.id,
    defect: readStored("defect", defectInputSchema, open.defect),
    submission,
    now: request.now,
  });
}

/** The open invalidations of one assignment. */
function openInvalidationsOf(db: CrewReader, assignmentId: string): InvalidationRow[] {
  return db
    .select()
    .from(invalidations)
    .where(eq(invalidations.assignmentId, assignmentId))
    .all()
    .filter((one) => one.state === "open");
}

/**
 * Returns each dependent the closed invalidations paused to the state the assignment machine
 * decides. Work that also read another invalid result keeps waiting for that correction.
 */
function resumeDependents(
  db: CrewWriter,
  request: { closed: InvalidationRow[]; cause: "resolved" | "merged"; now: string },
): string[] {
  const stillHeld = openPauses(db);
  const resumed: string[] = [];
  for (const one of request.closed) {
    for (const held of storedDependents(one.dependents)) {
      const row = readAssignment(db, held.assignmentId);
      if (row === null) {
        continue;
      }
      const decided = Assignment.decide("resume", {
        row,
        consumed: held.consumedState,
        cause: request.cause,
        submitted: latestSubmission(db, held.assignmentId) !== null,
        held: stillHeld.has(held.assignmentId),
      });
      if ("next" in decided) {
        moveAssignment(db, { row, next: decided.next, now: request.now });
        resumed.push(row.id);
      }
    }
  }
  return resumed;
}

/**
 * Records accepted completion of one assignment and releases the work its defects held, now that
 * a corrected result is accepted. The defects this result answers close first, so what is still
 * held is read from the rest. A dependent returns to the state it was paused from, and an
 * accepted one to the step that decided it, so its acceptance is decided again against the
 * corrected input. A corrected result is the condition those dependents waited on, so nothing
 * waits for a second decision that says the same thing twice.
 */
export function acceptAndRelease(
  db: CrewWriter,
  request: { row: AssignmentRow; next: AssignmentNext["accept"]; now: string },
): number {
  const closed = openInvalidationsOf(db, request.row.id);
  const revision = moveAssignment(db, request);
  resumeDependents(db, { closed, cause: "resolved", now: request.now });
  return revision;
}

/**
 * Closes each open invalidation of one source whose commit merged before any recall, once a
 * person settled that stack fault `merged_before_recall` (decision 24). A merged commit is never
 * corrected, so the invalidation and its open cycle close with no correction, the result is
 * accepted again and counts as landed, and the defect becomes a new issue. Each dependent it
 * paused returns to the state it was paused from, because its input is the merged commit, which
 * no correction changes. An invalidation whose correction already started stays open.
 */
export function closeMergedInvalidations(
  db: CrewWriter,
  request: { sourceId: string; now: string },
): string[] {
  const closing = openInvalidations(db).filter((one) => {
    const row = readAssignment(db, one.assignmentId);
    if (row === null || row.sourceId !== request.sourceId || row.state !== "invalidated") {
      return false;
    }
    const landing = currentLandingOf(db, row.id);
    const part = landing === null ? null : partOfCommit(db, row.sourceId, landing.landedCommit);
    return (
      part !== null &&
      part.status === "merged" &&
      faultsOf(db, part.publication).some(
        (fault) =>
          fault.part === part.pull.part && fault.fault === "merged_before_recall" && fault.settled,
      )
    );
  });

  for (const one of closing) {
    const row = readAssignment(db, one.assignmentId);
    const decided = row === null ? null : Assignment.decide("accept", { kind: "merged", row });
    if (row !== null && decided !== null && "next" in decided) {
      moveAssignment(db, { row, next: decided.next, now: request.now });
    }
  }
  resumeDependents(db, { closed: closing, cause: "merged", now: request.now });

  return closing.map((one) => one.assignmentId);
}
