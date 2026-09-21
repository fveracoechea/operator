import { eq } from "drizzle-orm";
import type { Capacity } from "./capacity.ts";
import type { CrewWriter } from "./database.ts";
import {
  activeAttempt,
  calculateFrontier,
  type FrontierBlocker,
  readAssignment,
} from "./frontier.ts";
import { assignments, attempts } from "./schema.ts";

export type ClaimResult =
  | {
      status: "claimed";
      assignmentId: string;
      attemptId: string;
      revision: number;
      kind: string;
      sourceId: string;
      sourceKey: string;
    }
  | { status: "unknown-assignment"; assignmentId: string }
  | { status: "stale-revision"; assignmentId: string; recordedRevision: number }
  | { status: "planning-only"; assignmentId: string; kind: string }
  | { status: "already-accepted"; assignmentId: string }
  | { status: "already-claimed"; assignmentId: string; attemptId: string }
  | { status: "not-dispatchable"; assignmentId: string; blockers: FrontierBlocker[] };

export function claimAssignment(
  db: CrewWriter,
  request: {
    assignmentId: string;
    revision: number;
    ownerToken: string;
    attemptId: string;
    capacity: Capacity;
    now: string;
  },
): ClaimResult {
  const row = readAssignment(db, request.assignmentId);
  if (row === null) {
    return { status: "unknown-assignment", assignmentId: request.assignmentId };
  }

  if (row.state === "accepted") {
    return { status: "already-accepted", assignmentId: row.id };
  }

  // A duplicate claim names the attempt that already holds this assignment, before it reports
  // the revision, because the holder is what a caller racing for this work needs to know.
  const live = activeAttempt(db, row.id);
  if (live !== null) {
    return { status: "already-claimed", assignmentId: row.id, attemptId: live.id };
  }

  // The caller states the revision it inspected, so a state that moved under it is refused.
  if (row.revision !== request.revision) {
    return {
      status: "stale-revision",
      assignmentId: row.id,
      recordedRevision: row.revision,
    };
  }

  // The frontier owns the dispatch rules, so a claim can never take work the frontier withheld.
  const frontier = calculateFrontier(db, request.capacity);
  if (!frontier.dispatchable.some((one) => one.assignmentId === row.id)) {
    const planning = frontier.planning.find((one) => one.assignmentId === row.id);
    if (planning !== undefined) {
      return { status: "planning-only", assignmentId: row.id, kind: row.kind };
    }

    const blocked = frontier.blocked.find((one) => one.assignmentId === row.id);
    return {
      status: "not-dispatchable",
      assignmentId: row.id,
      blockers: blocked?.blockers ?? [],
    };
  }

  db.insert(attempts)
    .values({
      id: request.attemptId,
      assignmentId: row.id,
      ownerToken: request.ownerToken,
      state: "active",
      revision: 1,
      startedAt: request.now,
      endedAt: null,
    })
    .run();

  const revision = row.revision + 1;
  db.update(assignments)
    .set({ state: "claimed", revision, updatedAt: request.now })
    .where(eq(assignments.id, row.id))
    .run();

  return {
    status: "claimed",
    assignmentId: row.id,
    attemptId: request.attemptId,
    revision,
    kind: row.kind,
    sourceId: row.sourceId,
    sourceKey: row.sourceKey,
  };
}
