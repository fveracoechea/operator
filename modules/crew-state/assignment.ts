import { eq } from "drizzle-orm";
import { z } from "zod";
import type { CrewReader, CrewWriter } from "./database.ts";
import { assignmentId, identityOf } from "./identity.ts";
import { readStoredValue } from "./stored.ts";
import { assignments } from "./schema.ts";

export type AssignmentRow = typeof assignments.$inferSelect;

/**
 * Every state one assignment can hold.
 * Registered work is dispatchable, claimed work has a writer, awaiting review has handed a
 * result over, rework owes a delegated correction, paused work read an invalid result,
 * invalidated work was accepted and then found defective, and accepted work unblocks a
 * dependent.
 */
export const assignmentStateSchema = z.enum([
  "registered",
  "claimed",
  "awaiting-review",
  "rework",
  "paused",
  "invalidated",
  "accepted",
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

/** What the caller decides about one new assignment. Everything else follows from registration. */
export type NewAssignment = {
  sourceId: string;
  sourceKey: string;
  sourceRevision: string;
  trackerBinding: string | null;
  title: string;
  kind: string;
  orderIndex: number;
  approvedScope: string;
  acceptanceRequirements: string[];
  permissions: { writePaths: string[]; allowedCommands: string[]; network: boolean };
  fixedInputs: Array<{
    name: string;
    kind: string;
    value: string;
    contentIdentity: string | null;
  }>;
};

/** The next free order index inside one source. */
export function nextOrderIndex(held: AssignmentRow[]): number {
  return held.reduce((highest, row) => Math.max(highest, row.orderIndex + 1), 0);
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
    sourceRevision: request.sourceRevision,
    trackerBinding: request.trackerBinding,
    title: request.title,
    kind: request.kind,
    orderIndex: request.orderIndex,
    approvedScope: request.approvedScope,
    acceptanceRequirements: JSON.stringify(request.acceptanceRequirements),
    permissions: JSON.stringify(request.permissions),
    fixedInputs: JSON.stringify(request.fixedInputs),
    fixedInputsIdentity: identityOf(request.fixedInputs),
    state: "registered",
    revision: 1,
    registeredAt: now,
    updatedAt: now,
  };

  db.insert(assignments).values(row).run();
  return row;
}

/**
 * Moves one assignment to its next state and returns the revision that move produced.
 * Every state an assignment reaches is written here, so a caller can never move one without
 * moving its revision, which is what a caller states back when it acts on what it read.
 */
export function moveAssignment(
  db: CrewWriter,
  request: { row: AssignmentRow; state: AssignmentState; now: string },
): number {
  const revision = request.row.revision + 1;
  db.update(assignments)
    .set({ state: request.state, revision, updatedAt: request.now })
    .where(eq(assignments.id, request.row.id))
    .run();
  return revision;
}
