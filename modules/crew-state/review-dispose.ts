import { eq } from "drizzle-orm";
import { readAssignment } from "./assignment.ts";
import { readSnapshot, storedSnapshotCommits } from "./branch-review.ts";
import type { CrewWriter } from "./database.ts";
import { invalidateResult } from "./invalidate.ts";
import { type DispositionInput, storedTargets } from "./review-input.ts";
import { type DisposeRefusal, Review } from "./review-machine.ts";
import { corrections, findingsOf, type ReviewRow, undisposed } from "./review.ts";
import { reviewFindings } from "./schema.ts";

/** One assignment a corrected branch finding invalidated, in the same change as the answer. */
export type BranchInvalidation = {
  assignmentId: string;
  invalidationId: string;
  findingIds: string[];
  dependents: string[];
  cycleId: string | null;
  directionRequestId: string | null;
};

export type DisposeOutcome =
  | {
      status: "disposed";
      reviewId: string;
      disposed: Array<{ findingId: string; disposition: string }>;
      outstanding: string[];
      corrections: string[];
      // The assignments the corrected branch findings invalidated. A result review has none.
      invalidated: BranchInvalidation[];
    }
  | DisposeRefusal;

/**
 * Records what the Operator decided about each finding. The review machine checks the answer,
 * and each corrected branch finding invalidates the one target it names in the same change.
 */
export function disposeFindings(
  db: CrewWriter,
  request: { review: ReviewRow; input: DispositionInput; now: string },
): DisposeOutcome {
  const { review } = request;
  const snapshot = review.snapshotId === null ? null : readSnapshot(db, review.snapshotId);
  const decided = Review.decide("dispose", {
    row: review,
    held: new Map(findingsOf(db, review.id).map((one) => [one.id, one])),
    input: request.input,
    commits: snapshot === null ? null : storedSnapshotCommits(snapshot.commits),
  });
  if ("refused" in decided) {
    return decided.refused;
  }
  const byFinding = decided.next.targets;

  for (const one of request.input.dispositions) {
    db.update(reviewFindings)
      .set({
        disposition: one.disposition,
        reason: one.reason,
        dispositionEvidence: one.disposition === "rejected" ? one.evidence : null,
        followUp: one.disposition === "deferred" ? one.followUp : null,
        disposedAt: request.now,
        correctionTarget: byFinding.get(one.findingId) ?? null,
      })
      .where(eq(reviewFindings.id, one.findingId))
      .run();
  }

  const invalidated = invalidateTargets(db, { review, byFinding, now: request.now });
  const settled = findingsOf(db, review.id);
  return {
    status: "disposed",
    reviewId: review.id,
    disposed: request.input.dispositions.map((one) => ({
      findingId: one.findingId,
      disposition: one.disposition,
    })),
    outstanding: undisposed(settled).map((one) => one.id),
    // A corrected branch finding is answered by its invalidation cycle, never by a findings cycle.
    corrections: review.snapshotId === null ? corrections(settled).map((one) => one.id) : [],
    invalidated,
  };
}

/**
 * Invalidates each target of a corrected branch finding through the path of ADR 0008, in the
 * same change as the answer, so a defect in accepted work keeps one path. Two findings that name
 * one target give one invalidation, and a target an earlier answer already invalidated is left.
 */
function invalidateTargets(
  db: CrewWriter,
  request: { review: ReviewRow; byFinding: Map<string, string>; now: string },
): BranchInvalidation[] {
  const grouped = new Map<string, string[]>();
  for (const [findingId, target] of request.byFinding) {
    grouped.set(target, [...(grouped.get(target) ?? []), findingId]);
  }

  return [...grouped].flatMap(([target, findingIds]): BranchInvalidation[] => {
    const row = readAssignment(db, target);
    if (row === null || row.state !== "accepted") {
      return [];
    }
    // The defect carries each finding in the reviewer's words, with its target commits and the
    // disposition that corrected it (ADR 0008).
    const answered = new Map(findingsOf(db, request.review.id).map((one) => [one.id, one]));
    const findings = findingIds.flatMap((id) => {
      const one = answered.get(id);
      return one === undefined ? [] : [one];
    });
    const invalidationId = crypto.randomUUID();
    const outcome = invalidateResult(db, {
      invalidationId,
      assignmentId: row.id,
      revision: row.revision,
      cycleId: crypto.randomUUID(),
      input: {
        summary: findings.map((one) => one.summary).join(" "),
        evidence: findings
          .map(
            (one) =>
              `${one.id} (targets ${one.targets === null ? "none" : storedTargets(one.targets).join(", ")}): ${one.evidence} Corrected: ${one.reason ?? ""}`,
          )
          .join("\n"),
        foundBy: `branch review ${request.review.id}`,
      },
      now: request.now,
    });
    return outcome.status !== "invalidated"
      ? []
      : [
          {
            assignmentId: row.id,
            invalidationId,
            findingIds,
            dependents: outcome.dependents.map((one) => one.assignmentId),
            cycleId: outcome.cycle?.cycleId ?? null,
            directionRequestId: outcome.direction?.directionRequestId ?? null,
          },
        ];
  });
}
