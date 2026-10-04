import { and, eq } from "drizzle-orm";
import { z } from "zod";
import type { AssignmentNext } from "./assignment-machine.ts";
import type { CrewReader, CrewWriter } from "./database.ts";
import { assignmentId, identityOf } from "./identity.ts";
import { readStoredValue } from "./stored.ts";
import {
  assignmentDependencies,
  assignments,
  directionRequests,
  invalidations,
  reworkCycles,
} from "./schema.ts";

export type AssignmentRow = typeof assignments.$inferSelect;

/**
 * Every state one assignment can hold.
 * Registered work is dispatchable, claimed work has a writer, awaiting review has handed a
 * result over, rework owes a delegated correction, paused work read an invalid result,
 * invalidated work was accepted and then found defective, accepted work unblocks a dependent,
 * and withdrawn work was removed from its parent by a person. A withdrawal is terminal and never
 * unblocks a dependent.
 */
export const assignmentStateSchema = z.enum([
  "registered",
  "claimed",
  "awaiting-review",
  "rework",
  "paused",
  "invalidated",
  "accepted",
  "withdrawn",
]);

export type AssignmentState = z.infer<typeof assignmentStateSchema>;

// An assignment row stores this column, and every reader takes it back through the schema that
// wrote it rather than asserting the state it expected.
export function storedAssignmentState(stored: string): AssignmentState {
  return readStoredValue("assignment state", assignmentStateSchema, stored);
}

export function readAssignment(db: CrewReader, id: string): AssignmentRow | null {
  return db.select().from(assignments).where(eq(assignments.id, id)).all()[0] ?? null;
}

/** What one assignment holds to do its work: its scope and the execution fields it runs with. */
export type AssignmentContent = {
  sourceRevision: string;
  trackerBinding: string | null;
  title: string;
  kind: string;
  planningType: string | null;
  approvedScope: string;
  scopeIdentity: string | null;
  acceptanceRequirements: string[];
  permissions: { writePaths: string[]; allowedCommands: string[]; network: boolean };
  fixedInputs: Array<{
    name: string;
    kind: string;
    value: string;
    contentIdentity: string | null;
  }>;
};

/** What the caller decides about one new assignment. Everything else follows from registration. */
export type NewAssignment = AssignmentContent & {
  sourceId: string;
  sourceKey: string;
  orderIndex: number;
};

/** The next free order index inside one source. */
export function nextOrderIndex(held: AssignmentRow[]): number {
  return held.reduce((highest, row) => Math.max(highest, row.orderIndex + 1), 0);
}

/**
 * The stored columns of one assignment content. A new row and a revised row both take them
 * from here, so a content column added to the table cannot reach one path and miss the other.
 */
function assignmentValuesOf(content: AssignmentContent) {
  return {
    sourceRevision: content.sourceRevision,
    trackerBinding: content.trackerBinding,
    title: content.title,
    kind: content.kind,
    planningType: content.planningType,
    approvedScope: content.approvedScope,
    scopeIdentity: content.scopeIdentity,
    acceptanceRequirements: JSON.stringify(content.acceptanceRequirements),
    permissions: JSON.stringify(content.permissions),
    fixedInputs: JSON.stringify(content.fixedInputs),
    fixedInputsIdentity: identityOf(content.fixedInputs),
  };
}

/**
 * Writes one new assignment row.
 * Registered work and the review a submission starts both arrive here, so a column added to
 * the table cannot reach one path and miss the other.
 */
export function insertAssignment(
  db: CrewWriter,
  request: NewAssignment,
  now: string,
): AssignmentRow {
  const row: AssignmentRow = {
    id: assignmentId(request.sourceId, request.sourceKey),
    sourceId: request.sourceId,
    sourceKey: request.sourceKey,
    orderIndex: request.orderIndex,
    ...assignmentValuesOf(request),
    state: "registered",
    revision: 1,
    registeredAt: now,
    updatedAt: now,
    withdrawnUnder: null,
  };

  db.insert(assignments).values(row).run();
  return row;
}

/**
 * Writes the new content of one recorded assignment that no work has read, and drops its
 * recorded dependencies, because the new content states them again.
 */
export function reviseAssignment(
  db: CrewWriter,
  request: { row: AssignmentRow; content: AssignmentContent; now: string },
): AssignmentRow {
  const { row, now } = request;
  const values = {
    ...assignmentValuesOf(request.content),
    revision: row.revision + 1,
    updatedAt: now,
  };
  db.update(assignments).set(values).where(eq(assignments.id, row.id)).run();
  db.delete(assignmentDependencies).where(eq(assignmentDependencies.assignmentId, row.id)).run();
  return { ...row, ...values };
}

/**
 * Moves one assignment to the next state the assignment machine decided, closes the open
 * correction records that move closes, and returns the revision the move produced.
 * Every state an assignment reaches is written here, so a caller can never move one without
 * moving its revision, which is what a caller states back when it acts on what it read.
 */
export function moveAssignment(
  db: CrewWriter,
  request: { row: AssignmentRow; next: AssignmentNext[keyof AssignmentNext]; now: string },
): number {
  const { row, next, now } = request;
  const revision = row.revision + 1;
  db.update(assignments)
    .set({ state: next.state, revision, updatedAt: now })
    .where(eq(assignments.id, row.id))
    .run();

  const { cycle, invalidation, direction } = next.closes;
  if (cycle !== undefined) {
    db.update(reworkCycles)
      .set({ state: cycle, updatedAt: now })
      .where(and(eq(reworkCycles.assignmentId, row.id), eq(reworkCycles.state, "open")))
      .run();
  }
  if (invalidation !== undefined) {
    db.update(invalidations)
      .set({ state: invalidation, resolvedAt: now })
      .where(and(eq(invalidations.assignmentId, row.id), eq(invalidations.state, "open")))
      .run();
  }
  if (direction !== undefined) {
    db.update(directionRequests)
      .set({ state: direction, updatedAt: now })
      .where(and(eq(directionRequests.assignmentId, row.id), eq(directionRequests.state, "open")))
      .run();
  }
  return revision;
}
