import { and, eq, inArray } from "drizzle-orm";
import type { CrewReader, CrewWriter } from "./database.ts";
import { type AssignmentRow, moveAssignment, readAssignment } from "./assignment.ts";
import { activeAttempt } from "./frontier.ts";
import { assignments, directionRequests, invalidations, reviews, reworkCycles } from "./schema.ts";
import { submissionsOf } from "./submission.ts";
import { trackerOperationsOf } from "./tracker.ts";

/**
 * Why one withdrawal waits. A withdrawal never stops work that nobody handed over, and recovery
 * comes before it, so each names the attempt or the effect a person waits for.
 */
export type WithdrawalRefusal =
  | {
      reason: "withdrawal_attempt_active";
      key: string;
      assignmentId: string;
      attemptId: string;
      // The assignment that holds the attempt: the item itself, or a review of its result.
      holder: string;
    }
  | {
      reason: "withdrawal_effect_unsettled";
      key: string;
      assignmentId: string;
      effect: "tracker_step";
      step: string;
      state: string;
    };

// A tracker step in one of these states has a recorded outcome. Every other state is unsettled.
const SETTLED_TRACKER_STATES = new Set(["verified", "failed"]);

/** Every review of a result of one assignment, oldest first. */
function reviewsOfWork(db: CrewReader, assignmentId: string) {
  const submitted = submissionsOf(db, assignmentId).map((one) => one.id);
  return submitted.length === 0
    ? []
    : db
        .select()
        .from(reviews)
        .where(inArray(reviews.submissionId, submitted))
        .all()
        .toSorted((left, right) => left.createdAt.localeCompare(right.createdAt));
}

/**
 * What refuses the withdrawal of one recorded assignment: each active attempt of it or of a
 * review of its result, then each tracker step with no recorded outcome. The rule reads the
 * recorded attempts, not a list of assignment states.
 */
export function withdrawalRefusals(db: CrewReader, row: AssignmentRow): WithdrawalRefusal[] {
  const holders = [row.id, ...reviewsOfWork(db, row.id).map((one) => one.assignmentId)];
  const attempts = [...new Set(holders)].flatMap((holder): WithdrawalRefusal[] => {
    const live = activeAttempt(db, holder);
    return live === null
      ? []
      : [
          {
            reason: "withdrawal_attempt_active",
            key: row.sourceKey,
            assignmentId: row.id,
            attemptId: live.id,
            holder,
          },
        ];
  });
  const effects = trackerOperationsOf(db, row.id)
    .filter((one) => !SETTLED_TRACKER_STATES.has(one.state))
    .map((one): WithdrawalRefusal => ({
      reason: "withdrawal_effect_unsettled",
      key: row.sourceKey,
      assignmentId: row.id,
      effect: "tracker_step",
      step: one.step,
      state: one.state,
    }));
  return [...attempts, ...effects];
}

function markWithdrawn(
  db: CrewWriter,
  request: { row: AssignmentRow; planRevision: string; now: string },
): void {
  moveAssignment(db, { row: request.row, state: "withdrawn", now: request.now });
  db.update(assignments)
    .set({ withdrawnUnder: request.planRevision })
    .where(eq(assignments.id, request.row.id))
    .run();
}

/**
 * Records one withdrawal under the plan revision its approval names. The assignment moves to
 * its terminal state, and its open cycle, its open invalidation, its open direction requests,
 * and each review of it that no attempt holds close in the same change. Every attempt,
 * submission, report, finding, and planning record stays as history.
 */
export function withdrawAssignment(
  db: CrewWriter,
  request: { row: AssignmentRow; planRevision: string; now: string },
): void {
  const { row, now } = request;
  markWithdrawn(db, request);

  db.update(reworkCycles)
    .set({ state: "withdrawn", updatedAt: now })
    .where(and(eq(reworkCycles.assignmentId, row.id), eq(reworkCycles.state, "open")))
    .run();
  db.update(invalidations)
    .set({ state: "withdrawn", resolvedAt: now })
    .where(and(eq(invalidations.assignmentId, row.id), eq(invalidations.state, "open")))
    .run();
  db.update(directionRequests)
    .set({ state: "withdrawn", updatedAt: now })
    .where(and(eq(directionRequests.assignmentId, row.id), eq(directionRequests.state, "open")))
    .run();

  // The refusals above leave no review attempt active, so no review here is still read.
  for (const review of reviewsOfWork(db, row.id)) {
    if (review.state !== "reported") {
      db.update(reviews)
        .set({ state: "withdrawn", revision: review.revision + 1, updatedAt: now })
        .where(eq(reviews.id, review.id))
        .run();
    }
    const holder = readAssignment(db, review.assignmentId);
    if (holder !== null && holder.state !== "accepted" && holder.state !== "withdrawn") {
      markWithdrawn(db, { row: holder, planRevision: request.planRevision, now });
    }
  }
}
