import { eq, inArray } from "drizzle-orm";
import { rebuildsBranch } from "./branch-move.ts";
import type { CrewReader, CrewWriter } from "./database.ts";
import { type AssignmentRow, moveAssignment, readAssignment } from "./assignment.ts";
import { Assignment } from "./assignment-machine.ts";
import { activeAttempt } from "./frontier.ts";
import { assignments, reviews } from "./schema.ts";
import { submissionsOf } from "./submission.ts";
import { trackerOperationsOf } from "./tracker.ts";
import { branchReviewHoldersOf, branchReviewsHolding } from "./branch-review.ts";
import { intendedLandingOf, intentTouches } from "./landing-record.ts";
import { Review } from "./review-machine.ts";
import { type ReviewRow, withdrawReview } from "./review.ts";

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
      // The assignment that holds the attempt: the item itself, a review of its result, or a
      // branch review whose snapshot holds its commit.
      holder: string;
    }
  | {
      reason: "withdrawal_effect_unsettled";
      key: string;
      assignmentId: string;
      effect: "tracker_step";
      step: string;
      state: string;
    }
  | {
      reason: "withdrawal_effect_unsettled";
      key: string;
      assignmentId: string;
      // A move of the integration branch whose outcome is not recorded: the landing of the item,
      // or a rewrite or a take-out that replaces, lands again, or takes out its commit.
      effect: "landing_intent" | "rewrite_intent";
      landingId: string;
      pendingAssignmentId: string;
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
 * review of its result, then each tracker step with no recorded outcome, then an open landing or
 * rewrite intent that moves its commit. The rule reads the recorded attempts, not a list of
 * assignment states.
 */
export function withdrawalRefusals(db: CrewReader, row: AssignmentRow): WithdrawalRefusal[] {
  // A branch review in flight would report on a head that can never be published, and it would
  // use one of the three rounds of the source, so it holds the withdrawal too.
  const holders = [
    row.id,
    ...reviewsOfWork(db, row.id).map((one) => one.assignmentId),
    ...branchReviewHoldersOf(db, row),
  ];
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
  // Recovery settles an open move first, so a withdrawal never decides about a commit in flight.
  const intent = intendedLandingOf(db, row.sourceId);
  const moves: WithdrawalRefusal[] =
    intent === null || !intentTouches(intent, row.id)
      ? []
      : [
          {
            reason: "withdrawal_effect_unsettled",
            key: row.sourceKey,
            assignmentId: row.id,
            effect: rebuildsBranch(intent.kind) ? "rewrite_intent" : "landing_intent",
            landingId: intent.id,
            pendingAssignmentId: intent.assignmentId,
          },
        ];
  return [...attempts, ...effects, ...moves];
}

/**
 * Withdraws one assignment under the plan revision its approval names, as the assignment machine
 * decides. The move closes its open cycle, its open invalidation, and its open direction requests.
 */
function markWithdrawn(
  db: CrewWriter,
  request: { row: AssignmentRow; as: "item" | "holder"; planRevision: string; now: string },
): void {
  const { row, now } = request;
  const decided = Assignment.decide("withdraw", { row, as: request.as });
  if ("refused" in decided) {
    return;
  }
  moveAssignment(db, { row, next: decided.next, now });
  db.update(assignments)
    .set({ withdrawnUnder: request.planRevision })
    .where(eq(assignments.id, row.id))
    .run();
}

/**
 * Closes one review of withdrawn work, as the review machine decides, and withdraws the
 * assignment that holds it. A reported review is finished, and a withdrawn branch review is
 * already closed, so each stays as it is with its holder.
 * The withdrawal refusals leave no review attempt active, so no review here is still read.
 */
function closeReview(
  db: CrewWriter,
  request: { review: ReviewRow; planRevision: string; now: string },
): void {
  const { review, now } = request;
  const decided = Review.decide("withdraw", { row: review });
  if ("refused" in decided || decided.next === "unchanged") {
    return;
  }
  withdrawReview(db, { review, now });
  const holder = readAssignment(db, review.assignmentId);
  if (holder !== null) {
    markWithdrawn(db, { row: holder, as: "holder", planRevision: request.planRevision, now });
  }
}

/**
 * Records one withdrawal under the plan revision its approval names. The assignment moves to
 * its terminal state, and its open cycle, its open invalidation, its open direction requests,
 * and each review of it that no attempt holds close in the same change. A registered branch
 * review whose snapshot holds this commit closes too, and it is not a reported round. Every
 * attempt, submission, report, finding, and planning record stays as history.
 */
export function withdrawAssignment(
  db: CrewWriter,
  request: { row: AssignmentRow; planRevision: string; now: string },
): void {
  const { row, planRevision, now } = request;
  markWithdrawn(db, { row, as: "item", planRevision, now });
  for (const review of [...reviewsOfWork(db, row.id), ...branchReviewsHolding(db, row)]) {
    closeReview(db, { review, planRevision, now });
  }
}
