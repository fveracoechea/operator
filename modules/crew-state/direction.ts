import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { matchApproval } from "./approvals.ts";
import type { CrewReader, CrewWriter } from "./database.ts";
import type { LimitKind } from "./rework.ts";
import { directionRequests } from "./schema.ts";
import { readStored } from "./stored.ts";

export type DirectionRequestRow = typeof directionRequests.$inferSelect;

/** The approval action a person grants to let one assignment pass a limit it reached. */
export const DIRECTION_ACTION = "limit-direction";

/** What was already tried, kept beside the request so the evidence outlives the session. */
const evidence = z.strictObject({
  used: z.int().nonnegative(),
  detail: z.string(),
  attempted: z.array(z.string()),
});

export type DirectionEvidence = z.infer<typeof evidence>;

export function storedDirectionEvidence(stored: string): DirectionEvidence {
  return readStored("direction evidence", evidence, stored);
}

export type DirectionRecord = {
  directionRequestId: string;
  assignmentId: string;
  limitKind: string;
  limitValue: number;
  state: string;
  revision: number;
  approvalId: string | null;
  evidence: DirectionEvidence;
  raisedAt: string;
  // The exact approval that carries the user's direction past this request.
  approval: { action: string; targets: string[]; scope: string; requestRevision: string };
};

/** The approval one direction request accepts. It names the request revision it answers. */
function approvalFor(row: DirectionRequestRow): DirectionRecord["approval"] {
  return {
    action: DIRECTION_ACTION,
    targets: [row.assignmentId],
    scope: `limit:${row.limitKind}`,
    requestRevision: String(row.revision),
  };
}

export function directionRecordOf(row: DirectionRequestRow): DirectionRecord {
  return {
    directionRequestId: row.id,
    assignmentId: row.assignmentId,
    limitKind: row.limitKind,
    limitValue: row.limitValue,
    state: row.state,
    revision: row.revision,
    approvalId: row.approvalId,
    evidence: storedDirectionEvidence(row.evidence),
    raisedAt: row.raisedAt,
    approval: approvalFor(row),
  };
}

function readRequest(
  db: CrewReader,
  request: { assignmentId: string; limitKind: LimitKind },
): DirectionRequestRow | null {
  return (
    db
      .select()
      .from(directionRequests)
      .where(
        and(
          eq(directionRequests.assignmentId, request.assignmentId),
          eq(directionRequests.limitKind, request.limitKind),
        ),
      )
      .all()[0] ?? null
  );
}

/** Every direction one assignment still waits on. An open one blocks its acceptance. */
export function openDirectionsOf(db: CrewReader, assignmentId: string): DirectionRequestRow[] {
  return db
    .select()
    .from(directionRequests)
    .where(
      and(eq(directionRequests.assignmentId, assignmentId), eq(directionRequests.state, "open")),
    )
    .all()
    .toSorted((left, right) => left.limitKind.localeCompare(right.limitKind));
}

/**
 * Records that one limit is reached and that the work now waits on the user.
 * Reaching the same limit again moves the revision, so an approval granted against the earlier
 * request no longer covers the new one. Nothing that was already recorded is removed.
 */
export function raiseDirection(
  db: CrewWriter,
  request: {
    directionRequestId: string;
    assignmentId: string;
    limitKind: LimitKind;
    limitValue: number;
    evidence: DirectionEvidence;
    now: string;
  },
): DirectionRecord {
  const held = readRequest(db, request);
  if (held === null) {
    const row: DirectionRequestRow = {
      id: request.directionRequestId,
      assignmentId: request.assignmentId,
      limitKind: request.limitKind,
      limitValue: request.limitValue,
      evidence: JSON.stringify(request.evidence),
      state: "open",
      approvalId: null,
      revision: 1,
      raisedAt: request.now,
      updatedAt: request.now,
    };
    db.insert(directionRequests).values(row).run();
    return directionRecordOf(row);
  }

  if (held.state === "open") {
    // The request keeps its revision, because an approval is bound to it, and it keeps taking
    // the evidence of every further attempt that reached the same limit.
    const grown = { ...held, evidence: JSON.stringify(request.evidence), updatedAt: request.now };
    db.update(directionRequests)
      .set({ evidence: grown.evidence, updatedAt: request.now })
      .where(eq(directionRequests.id, held.id))
      .run();
    return directionRecordOf(grown);
  }

  const raised = {
    ...held,
    evidence: JSON.stringify(request.evidence),
    state: "open",
    approvalId: null,
    revision: held.revision + 1,
    updatedAt: request.now,
  };
  db.update(directionRequests)
    .set({
      evidence: raised.evidence,
      state: raised.state,
      approvalId: null,
      revision: raised.revision,
      updatedAt: request.now,
    })
    .where(eq(directionRequests.id, held.id))
    .run();
  return directionRecordOf(raised);
}

export type DirectionCheck =
  | { status: "unblocked" }
  | { status: "directed"; request: DirectionRecord; approvalId: string }
  | { status: "blocked"; request: DirectionRecord; approval: "missing" | "revoked" };

/**
 * Reads whether a person already directed the work past one reached limit.
 * The direction arrives as an approval that names this assignment and the revision of the
 * request it answers, so silence, a timeout, and a general direction to finish carry nothing.
 */
export function readDirection(
  db: CrewReader,
  request: { assignmentId: string; limitKind: LimitKind },
): DirectionCheck {
  const held = readRequest(db, request);
  if (held === null || held.state !== "open") {
    return { status: "unblocked" };
  }

  const record = directionRecordOf(held);
  const match = matchApproval(db, record.approval);
  if (match.status === "matched") {
    return { status: "directed", request: record, approvalId: match.approval.approvalId };
  }

  return { status: "blocked", request: record, approval: match.status };
}

/** Records the approval that carried the user's direction, which closes the request. */
export function settleDirection(
  db: CrewWriter,
  request: { directionRequestId: string; approvalId: string; now: string },
): void {
  db.update(directionRequests)
    .set({ state: "directed", approvalId: request.approvalId, updatedAt: request.now })
    .where(eq(directionRequests.id, request.directionRequestId))
    .run();
}
