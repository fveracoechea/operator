import { eq } from "drizzle-orm";
import type { CrewWriter } from "./database.ts";
import type { DispositionInput } from "./review-input.ts";
import { findingsOf, type ReviewRow } from "./review.ts";
import { reviewFindings } from "./schema.ts";

export type DisposeOutcome =
  | {
      status: "disposed";
      reviewId: string;
      disposed: Array<{ findingId: string; disposition: string }>;
      outstanding: string[];
      corrections: string[];
    }
  | { status: "review-not-reported"; reviewId: string; state: string }
  | { status: "unknown-finding"; reviewId: string; findingIds: string[] }
  | { status: "blocker-not-deferrable"; reviewId: string; findingIds: string[] };

/**
 * Records what the Operator decided about each finding.
 * A finding is corrected, rejected with a reason, or deferred with a reason and a follow-up,
 * so no finding leaves the review without an answer.
 */
export function disposeFindings(
  db: CrewWriter,
  request: { review: ReviewRow; input: DispositionInput; now: string },
): DisposeOutcome {
  const { review } = request;
  if (review.state !== "reported") {
    return { status: "review-not-reported", reviewId: review.id, state: review.state };
  }

  const held = new Map(findingsOf(db, review.id).map((one) => [one.id, one]));
  const unknown = request.input.dispositions
    .map((one) => one.findingId)
    .filter((id) => !held.has(id));
  if (unknown.length > 0) {
    return { status: "unknown-finding", reviewId: review.id, findingIds: unknown };
  }

  // An improvement may wait. A blocker is either corrected or rejected with a stated reason,
  // because deferring one would waive an approved requirement through judgment alone.
  const deferredBlockers = request.input.dispositions
    .filter(
      (one) => one.disposition === "deferred" && held.get(one.findingId)?.severity === "blocker",
    )
    .map((one) => one.findingId);
  if (deferredBlockers.length > 0) {
    return { status: "blocker-not-deferrable", reviewId: review.id, findingIds: deferredBlockers };
  }

  for (const one of request.input.dispositions) {
    db.update(reviewFindings)
      .set({
        disposition: one.disposition,
        reason: one.reason,
        followUp: one.disposition === "deferred" ? one.followUp : null,
        disposedAt: request.now,
      })
      .where(eq(reviewFindings.id, one.findingId))
      .run();
  }

  const settled = findingsOf(db, review.id);
  return {
    status: "disposed",
    reviewId: review.id,
    disposed: request.input.dispositions.map((one) => ({
      findingId: one.findingId,
      disposition: one.disposition,
    })),
    outstanding: settled.filter((one) => one.disposition === null).map((one) => one.id),
    corrections: settled.filter((one) => one.disposition === "corrected").map((one) => one.id),
  };
}
