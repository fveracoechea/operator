import type { Capacity } from "./capacity.ts";
import type { CrewReader, CrewWriter } from "./database.ts";
import { moveAssignment, readAssignment } from "./assignment.ts";
import { Assignment, type AssignmentFacts, type ClaimRefusal } from "./assignment-machine.ts";
import { startAttempt } from "./attempt.ts";
import { activeAttempt, calculateFrontier } from "./frontier.ts";
import { openDirectedCorrection } from "./invalidate.ts";
import { spendDirection } from "./direction.ts";
import { isReview } from "./work-input.ts";

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
  | ClaimRefusal;

/** What the frontier did with one assignment. The frontier owns the dispatch rules. */
function offeredOf(
  db: CrewReader,
  request: { assignmentId: string; capacity: Capacity },
): AssignmentFacts["claim"]["offered"] {
  const frontier = calculateFrontier(db, request.capacity);
  if (frontier.dispatchable.some((one) => one.assignmentId === request.assignmentId)) {
    return "dispatchable";
  }
  if (frontier.planning.some((one) => one.assignmentId === request.assignmentId)) {
    return "planning";
  }
  const blocked = frontier.blocked.find((one) => one.assignmentId === request.assignmentId);
  return { blockers: blocked?.blockers ?? [] };
}

export function claimAssignment(
  db: CrewWriter,
  request: {
    assignmentId: string;
    revision: number;
    ownerToken: string;
    attemptId: string;
    cycleId: string;
    capacity: Capacity;
    now: string;
  },
): ClaimResult {
  const row = readAssignment(db, request.assignmentId);
  if (row === null) {
    return { status: "unknown-assignment", assignmentId: request.assignmentId };
  }

  const decided = Assignment.decide("claim", {
    row,
    revision: request.revision,
    live: activeAttempt(db, row.id),
    offered: offeredOf(db, { assignmentId: row.id, capacity: request.capacity }),
  });
  if ("refused" in decided) {
    return decided.refused;
  }

  // An invalidation that found the budget spent opens its cycle only after the user directed it,
  // and the frontier offers it only then, so this claim spends that direction.
  if (row.state === "invalidated") {
    const correction = openDirectedCorrection(db, {
      assignmentId: row.id,
      cycleId: request.cycleId,
      now: request.now,
    });
    if (correction?.status === "limit-reached") {
      return {
        status: "not-dispatchable",
        assignmentId: row.id,
        blockers: [
          {
            reason: "direction_required",
            directionRequestId: correction.direction.directionRequestId,
            limitKind: correction.limitKind,
          },
        ],
      };
    }
  }

  // A fourth branch review waits on the user, and the frontier offers it only once the user
  // directed it, so this claim spends that direction (ADR 0008, ADR 0017).
  if (isReview(row.kind)) {
    spendDirection(db, { assignmentId: row.id, limitKind: "branch_reviews", now: request.now });
  }

  startAttempt(db, {
    attemptId: request.attemptId,
    assignmentId: row.id,
    ownerToken: request.ownerToken,
    now: request.now,
  });

  const revision = moveAssignment(db, { row, next: decided.next, now: request.now });

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
