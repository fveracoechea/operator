import { eq } from "drizzle-orm";
import { readAssignment } from "./assignment.ts";
import { readSnapshot, storedSnapshotCommits } from "./branch-review.ts";
import type { CrewWriter } from "./database.ts";
import { invalidateResult } from "./invalidate.ts";
import { type DispositionInput, type FindingDisposition, storedTargets } from "./review-input.ts";
import {
  corrections,
  findingsOf,
  type ReviewFindingRow,
  type ReviewRow,
  undisposed,
} from "./review.ts";
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
  | { status: "review-not-reported"; reviewId: string; state: string }
  | { status: "correction-target-required"; reviewId: string; findingIds: string[] }
  | { status: "correction-target-not-expected"; reviewId: string; findingIds: string[] }
  | {
      status: "correction-target-unknown";
      reviewId: string;
      findings: Array<{ findingId: string; target: string; allowed: string[] }>;
    }
  | { status: "unknown-finding"; reviewId: string; findingIds: string[] }
  | { status: "blocker-not-deferrable"; reviewId: string; findingIds: string[] };

/**
 * Records what the Operator decided about each finding.
 * Every finding is answered: corrected, rejected with a reason and the evidence that refutes it,
 * or deferred with a reason and a follow-up reference.
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

  const targets = correctionTargets(db, { review, held, input: request.input });
  if (targets.status !== "ok") {
    return targets;
  }

  for (const one of request.input.dispositions) {
    db.update(reviewFindings)
      .set({
        disposition: one.disposition,
        reason: one.reason,
        dispositionEvidence: one.disposition === "rejected" ? one.evidence : null,
        followUp: one.disposition === "deferred" ? one.followUp : null,
        disposedAt: request.now,
        correctionTarget: targets.byFinding.get(one.findingId) ?? null,
      })
      .where(eq(reviewFindings.id, one.findingId))
      .run();
  }

  const invalidated = invalidateTargets(db, {
    review,
    byFinding: targets.byFinding,
    now: request.now,
  });
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

type TargetCheck =
  | { status: "ok"; byFinding: Map<string, string> }
  | Extract<
      DisposeOutcome,
      {
        status:
          | "correction-target-required"
          | "correction-target-not-expected"
          | "correction-target-unknown";
      }
    >;

/**
 * The one target assignment each corrected branch finding names. It must hold one of the commits
 * the finding targets, because a correction invalidates exactly that accepted result (ADR 0017).
 * A finding of a result review targets its own submission, so it names no target.
 */
function correctionTargets(
  db: CrewWriter,
  request: { review: ReviewRow; held: Map<string, ReviewFindingRow>; input: DispositionInput },
): TargetCheck {
  const { review } = request;
  const corrected = request.input.dispositions.filter(
    (one): one is Extract<FindingDisposition, { disposition: "corrected" }> =>
      one.disposition === "corrected",
  );
  const snapshot = review.snapshotId === null ? null : readSnapshot(db, review.snapshotId);
  if (snapshot === null) {
    const named = corrected.filter((one) => one.target !== undefined).map((one) => one.findingId);
    return named.length === 0
      ? { status: "ok", byFinding: new Map() }
      : { status: "correction-target-not-expected", reviewId: review.id, findingIds: named };
  }

  const missing = corrected.filter((one) => one.target === undefined).map((one) => one.findingId);
  if (missing.length > 0) {
    return { status: "correction-target-required", reviewId: review.id, findingIds: missing };
  }
  const commits = storedSnapshotCommits(snapshot.commits);
  const unknown = corrected.flatMap((one) => {
    const finding = request.held.get(one.findingId);
    const aimed = finding?.targets == null ? [] : storedTargets(finding.targets);
    const allowed = [
      ...new Set(
        commits
          .filter((commit) => aimed.includes(commit.commit))
          .map((commit) => commit.assignmentId),
      ),
    ];
    const target = one.target ?? "";
    return allowed.includes(target) ? [] : [{ findingId: one.findingId, target, allowed }];
  });
  if (unknown.length > 0) {
    return { status: "correction-target-unknown", reviewId: review.id, findings: unknown };
  }
  return {
    status: "ok",
    byFinding: new Map(corrected.map((one) => [one.findingId, one.target ?? ""])),
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
