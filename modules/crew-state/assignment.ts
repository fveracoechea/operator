import { eq } from "drizzle-orm";
import type { CrewWriter } from "./database.ts";
import { assignmentId, identityOf } from "./identity.ts";
import { assignments } from "./schema.ts";

export type AssignmentRow = typeof assignments.$inferSelect;

/** What the caller decides about one new assignment. Everything else follows from registration. */
export type NewAssignment = {
  sourceId: string;
  sourceKey: string;
  sourceRevision: string;
  trackerRef: string | null;
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
    trackerRef: request.trackerRef,
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

/** Records accepted completion on one assignment row. The only writer of that transition. */
export function markAccepted(db: CrewWriter, request: { row: AssignmentRow; now: string }): number {
  const revision = request.row.revision + 1;
  db.update(assignments)
    .set({ state: "accepted", revision, updatedAt: request.now })
    .where(eq(assignments.id, request.row.id))
    .run();
  return revision;
}
