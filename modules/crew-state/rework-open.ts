import { eq } from "drizzle-orm";
import type { CrewReader, CrewWriter } from "./database.ts";
import {
  type DirectionRecord,
  raiseDirection,
  readDirection,
  settleDirection,
} from "./direction.ts";
import { readAssignment } from "./assignment.ts";
import { identityOf } from "./identity.ts";
import {
  corrections,
  findingsOf,
  readReview,
  type ReviewFindingRow,
  undisposed,
} from "./review.ts";
import { type ReworkBriefRecord, type ReworkCorrection, type ReworkInput } from "./rework-input.ts";
import { cyclesOf, cyclesUsed, insertCycle, limitKindOf, limitOf, openCycleOf } from "./rework.ts";
import { assignments } from "./schema.ts";
import { storedChecks, storedCode, storedResultKind } from "./submission-input.ts";
import { latestSubmission, type SubmissionRow } from "./submission.ts";
import { storedArtifacts } from "./submission-store.ts";

export type ReworkOutcome =
  | {
      status: "delegated";
      cycleId: string;
      assignmentId: string;
      revision: number;
      reason: string;
      cycleIndex: number;
      limit: number;
      submissionId: string;
      reviewId: string | null;
      corrections: string[];
      conflicts: number;
      briefIdentity: string;
      approvalId: string | null;
    }
  | { status: "unknown-assignment"; assignmentId: string }
  | { status: "stale-revision"; assignmentId: string; recordedRevision: number }
  | { status: "not-awaiting-review"; assignmentId: string; state: string }
  | { status: "submission-required"; assignmentId: string }
  | { status: "cycle-open"; assignmentId: string; cycleId: string; reason: string }
  | { status: "unknown-review"; reviewId: string }
  | { status: "review-not-of-submission"; reviewId: string; submissionId: string }
  | { status: "review-not-reported"; reviewId: string; state: string }
  | { status: "findings-undisposed"; reviewId: string; findingIds: string[] }
  | { status: "no-corrections"; reviewId: string }
  | { status: "conflict-not-corrected"; reviewId: string; findingIds: string[] }
  | { status: "unknown-check"; assignmentId: string; names: string[] }
  | { status: "checks-passed"; assignmentId: string; names: string[] }
  | {
      status: "limit-reached";
      assignmentId: string;
      limitKind: string;
      limit: number;
      used: number;
      direction: DirectionRecord;
      approval: "missing" | "revoked";
    };

type ReworkRequest = {
  cycleId: string;
  assignmentId: string;
  revision: number;
  input: ReworkInput;
  now: string;
};

/** The findings the Operator accepted for correction, as the rework brief carries them. */
function correctionsOf(findings: ReviewFindingRow[]): ReworkCorrection[] {
  return corrections(findings).map((one) => ({
    findingId: one.id,
    axis: one.axis,
    key: one.findingKey,
    severity: one.severity,
    summary: one.summary,
    evidence: one.evidence,
    reason: one.reason ?? "",
  }));
}

type ReviewGate =
  | { status: "ok"; corrections: ReworkCorrection[] }
  | Extract<
      ReworkOutcome,
      {
        status:
          | "unknown-review"
          | "review-not-of-submission"
          | "review-not-reported"
          | "findings-undisposed"
          | "no-corrections"
          | "conflict-not-corrected";
      }
    >;

/**
 * Reads the review one correction cycle answers.
 * Every finding must already carry a disposition, because a cycle that starts on a half-read
 * review would leave the unanswered findings behind with nothing to return to them.
 */
function reviewGate(
  db: CrewReader,
  request: { reviewId: string; submission: SubmissionRow; input: ReworkInput },
): ReviewGate {
  const review = readReview(db, request.reviewId);
  if (review === null) {
    return { status: "unknown-review", reviewId: request.reviewId };
  }
  if (review.submissionId !== request.submission.id) {
    return {
      status: "review-not-of-submission",
      reviewId: review.id,
      submissionId: request.submission.id,
    };
  }
  if (review.state !== "reported") {
    return { status: "review-not-reported", reviewId: review.id, state: review.state };
  }

  const findings = findingsOf(db, review.id);
  const open = undisposed(findings);
  if (open.length > 0) {
    return {
      status: "findings-undisposed",
      reviewId: review.id,
      findingIds: open.map((one) => one.id),
    };
  }

  const accepted = correctionsOf(findings);
  if (request.input.reason === "findings" && accepted.length === 0) {
    return { status: "no-corrections", reviewId: review.id };
  }

  // A conflict names what the Operative must settle. A finding inside one is delegated work,
  // so it must be a correction this cycle actually carries.
  const held = new Set(findings.map((one) => one.id));
  const corrected = new Set(accepted.map((one) => one.findingId));
  const stray = request.input.conflicts
    .flatMap((one) => one.between)
    .filter((name) => held.has(name) && !corrected.has(name));
  if (stray.length > 0) {
    return {
      status: "conflict-not-corrected",
      reviewId: review.id,
      findingIds: [...new Set(stray)],
    };
  }

  return { status: "ok", corrections: accepted };
}

/** The recorded checks a diagnostic rerun names, and the reason a rerun is warranted at all. */
function diagnosticGate(
  submission: SubmissionRow,
  names: string[],
): { status: "ok" } | Extract<ReworkOutcome, { status: "unknown-check" | "checks-passed" }> {
  const recorded = new Map(storedChecks(submission.checks).map((one) => [one.name, one]));
  const unknown = names.filter((name) => !recorded.has(name));
  if (unknown.length > 0) {
    return { status: "unknown-check", assignmentId: submission.assignmentId, names: unknown };
  }

  // A rerun exists for a check that did not pass. A passing check has nothing to diagnose.
  const failing = names.filter((name) => recorded.get(name)?.outcome !== "passed");
  return failing.length > 0
    ? { status: "ok" }
    : { status: "checks-passed", assignmentId: submission.assignmentId, names };
}

function briefOf(request: {
  input: ReworkInput;
  submission: SubmissionRow;
  cycleIndex: number;
  limit: number;
  corrections: ReworkCorrection[];
}): ReworkBriefRecord {
  const { input, submission } = request;
  const checks = storedChecks(submission.checks);

  return {
    reason: input.reason,
    cycleIndex: request.cycleIndex,
    limit: request.limit,
    instruction: input.instruction,
    reviewId: input.reason === "diagnostic" ? null : input.reviewId,
    submissionId: submission.id,
    submissionIdentity: submission.identity,
    resultKind: storedResultKind(submission.resultKind),
    corrections: request.corrections,
    conflicts: input.conflicts,
    combines: input.reason === "integration" ? input.combines : [],
    // A diagnostic rerun names the checks it suspects. Every other cycle carries them all.
    checks:
      input.reason === "diagnostic"
        ? checks.filter((one) => input.checks.includes(one.name))
        : checks,
    code: submission.code === null ? null : storedCode(submission.code),
    artifacts: storedArtifacts(submission.artifacts),
  };
}

/**
 * Delegates one rework cycle on one submitted result.
 * The cycle is registered against the assignment, never against the review, so the work goes
 * to a fresh Operative through the ordinary claim and dispatch path. The reviewer that found
 * the problem and the Operator that disposed of it both stay out of the repair.
 */
export function openReworkCycle(db: CrewWriter, request: ReworkRequest): ReworkOutcome {
  const row = readAssignment(db, request.assignmentId);
  if (row === null) {
    return { status: "unknown-assignment", assignmentId: request.assignmentId };
  }
  if (row.revision !== request.revision) {
    return { status: "stale-revision", assignmentId: row.id, recordedRevision: row.revision };
  }

  const open = openCycleOf(db, row.id);
  if (open !== null) {
    return { status: "cycle-open", assignmentId: row.id, cycleId: open.id, reason: open.reason };
  }
  // One cycle answers one submitted result, so it starts from a result that is handed over.
  if (row.state !== "awaiting-review") {
    return { status: "not-awaiting-review", assignmentId: row.id, state: row.state };
  }

  const submission = latestSubmission(db, row.id);
  if (submission === null) {
    return { status: "submission-required", assignmentId: row.id };
  }

  const { input } = request;
  let accepted: ReworkCorrection[] = [];
  if (input.reason === "diagnostic") {
    const diagnostic = diagnosticGate(submission, input.checks);
    if (diagnostic.status !== "ok") {
      return diagnostic;
    }
  } else {
    const gate = reviewGate(db, { reviewId: input.reviewId, submission, input });
    if (gate.status !== "ok") {
      return gate;
    }
    accepted = gate.corrections;
  }

  const limit = limitOf(input.reason);
  const limitKind = limitKindOf(input.reason);
  const used = cyclesUsed(cyclesOf(db, row.id), input.reason);
  let approvalId: string | null = null;

  if (used >= limit) {
    const direction = readDirection(db, { assignmentId: row.id, limitKind });
    if (direction.status === "directed") {
      settleDirection(db, {
        directionRequestId: direction.request.directionRequestId,
        approvalId: direction.approvalId,
        now: request.now,
      });
      approvalId = direction.approvalId;
    } else {
      // The limit is reached, so the work waits on the user. The evidence of what was tried
      // stays recorded, because a limit that erased its own history would teach nobody.
      const raised = raiseDirection(db, {
        directionRequestId: crypto.randomUUID(),
        assignmentId: row.id,
        limitKind,
        limitValue: limit,
        evidence: {
          used,
          detail: `${used} ${limitKind} already ran on assignment ${row.id}.`,
          attempted: cyclesOf(db, row.id).map(
            (one) => `${one.reason} cycle ${one.cycleIndex} (${one.state})`,
          ),
        },
        now: request.now,
      });
      return {
        status: "limit-reached",
        assignmentId: row.id,
        limitKind,
        limit,
        used,
        direction: raised,
        approval: direction.status === "blocked" ? direction.approval : "missing",
      };
    }
  }

  const cycleIndex = used + 1;
  const brief = briefOf({
    input,
    submission,
    cycleIndex,
    limit,
    corrections: accepted,
  });
  insertCycle(db, {
    cycleId: request.cycleId,
    assignmentId: row.id,
    submissionId: submission.id,
    reviewId: brief.reviewId,
    reason: input.reason,
    cycleIndex,
    brief,
    briefIdentity: identityOf(brief),
    approvalId,
    now: request.now,
  });

  const revision = row.revision + 1;
  db.update(assignments)
    .set({ state: "rework", revision, updatedAt: request.now })
    .where(eq(assignments.id, row.id))
    .run();

  return {
    status: "delegated",
    cycleId: request.cycleId,
    assignmentId: row.id,
    revision,
    reason: input.reason,
    cycleIndex,
    limit,
    submissionId: submission.id,
    reviewId: brief.reviewId,
    corrections: accepted.map((one) => one.findingId),
    conflicts: input.conflicts.length,
    briefIdentity: identityOf(brief),
    approvalId,
  };
}
