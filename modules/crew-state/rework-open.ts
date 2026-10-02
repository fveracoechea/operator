import type { CrewReader, CrewWriter } from "./database.ts";
import {
  type DirectionRecord,
  raiseDirection,
  spendDirection,
  type Unapproved,
} from "./direction.ts";
import { moveAssignment, readAssignment } from "./assignment.ts";
import { identityOf } from "./identity.ts";
import {
  corrections,
  findingsOf,
  readReview,
  type ReviewFindingRow,
  reviewOfSubmission,
  undisposed,
} from "./review.ts";
import {
  type DefectInput,
  type ReworkBriefRecord,
  type ReworkCorrection,
  type ReworkInput,
  type ReworkInvalidation,
  type ReworkReason,
} from "./rework-input.ts";
import {
  budgetOf,
  cyclesOf,
  cyclesUsed,
  insertCycle,
  type LimitKind,
  openCycleOf,
} from "./rework.ts";
import { storedChecks, storedCode, storedResultKind } from "./submission-input.ts";
import {
  landedCommitOf,
  latestSubmission,
  type SubmissionRow,
  submissionsOf,
} from "./submission.ts";
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
      limitKind: LimitKind;
      limit: number;
      used: number;
      direction: DirectionRecord;
      approval: Unapproved;
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
 * The review one cycle answers.
 * A findings cycle always names it. An integration cycle names it only when it answers that
 * review as well, so a revision that must be combined before any review reported still can be.
 * A review that already reported is answered whether or not the caller named it, because its
 * findings would otherwise be combined away unanswered.
 */
function reviewOfCycle(
  db: CrewReader,
  request: { input: ReworkInput; submission: SubmissionRow },
): string | null {
  if (request.input.reason === "diagnostic") {
    return null;
  }
  if (request.input.reviewId !== undefined) {
    return request.input.reviewId;
  }

  const reported = reviewOfSubmission(db, request.submission.id);
  return reported !== null && reported.state === "reported" ? reported.id : null;
}

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

  return { status: "ok", corrections: accepted };
}

/**
 * Refuses a conflict that names a finding this cycle does not carry.
 * A conflict is work the Operative settles, so every finding inside one is a correction the
 * cycle delegates. This reads every round of the assignment, not only the review the cycle
 * answers, so a finding from an earlier round cannot be named into a cycle that ignores it.
 */
function conflictGate(
  db: CrewReader,
  request: {
    assignmentId: string;
    input: ReworkInput;
    corrections: ReworkCorrection[];
  },
): Extract<ReworkOutcome, { status: "conflict-not-corrected" }> | null {
  const rounds = submissionsOf(db, request.assignmentId).flatMap((submission) => {
    const review = reviewOfSubmission(db, submission.id);
    return review === null ? [] : [review];
  });
  const held = new Map(
    rounds.flatMap((review) => findingsOf(db, review.id).map((one) => [one.id, review.id])),
  );
  const carried = new Set(request.corrections.map((one) => one.findingId));

  const stray = [
    ...new Set(
      request.input.conflicts
        .flatMap((one) => one.between)
        .filter((name) => held.has(name) && !carried.has(name)),
    ),
  ];
  const first = stray[0];
  return first === undefined
    ? null
    : {
        status: "conflict-not-corrected",
        reviewId: held.get(first) ?? "",
        findingIds: stray,
      };
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

type Budget =
  | { status: "open"; cycleIndex: number; limit: number; approvalId: string | null }
  | Extract<ReworkOutcome, { status: "limit-reached" }>;

/**
 * The place of the next cycle in the budget its reason spends.
 * Past the limit, a direction of the user is spent here, or the request for one is recorded.
 * Every cycle reaches its budget through this one step, so no reason counts on its own.
 */
function spendBudget(
  db: CrewWriter,
  request: { assignmentId: string; reason: ReworkReason; now: string },
): Budget {
  const { kind: limitKind, limit } = budgetOf(request.reason);
  const used = cyclesUsed(cyclesOf(db, request.assignmentId), request.reason);
  if (used < limit) {
    return { status: "open", cycleIndex: used + 1, limit, approvalId: null };
  }

  const spent = spendDirection(db, {
    assignmentId: request.assignmentId,
    limitKind,
    now: request.now,
  });
  if (spent.status === "directed") {
    return { status: "open", cycleIndex: used + 1, limit, approvalId: spent.approvalId };
  }

  // The limit is reached, so the work waits on the user. The evidence of what was tried
  // stays recorded, because a limit that erased its own history would teach nobody.
  const raised = raiseDirection(db, {
    directionRequestId: crypto.randomUUID(),
    assignmentId: request.assignmentId,
    limitKind,
    limitValue: limit,
    evidence: {
      used,
      detail: `${used} ${limitKind} already ran on assignment ${request.assignmentId}.`,
      attempted: cyclesOf(db, request.assignmentId).map(
        (one) => `${one.reason} cycle ${one.cycleIndex} (${one.state})`,
      ),
    },
    now: request.now,
  });
  return {
    status: "limit-reached",
    assignmentId: request.assignmentId,
    limitKind,
    limit,
    used,
    direction: raised,
    approval: spent.approval,
  };
}

/** The submitted result one cycle reworks, as every brief of a cycle carries it. */
function resultOf(submission: SubmissionRow) {
  return {
    submissionId: submission.id,
    submissionIdentity: submission.identity,
    resultKind: storedResultKind(submission.resultKind),
    code: submission.code === null ? null : storedCode(submission.code),
    artifacts: storedArtifacts(submission.artifacts),
  };
}

function briefOf(request: {
  input: ReworkInput;
  submission: SubmissionRow;
  reviewId: string | null;
  cycleIndex: number;
  limit: number;
  approvalId: string | null;
  corrections: ReworkCorrection[];
}): ReworkBriefRecord {
  const { input, submission } = request;
  const checks = storedChecks(submission.checks);

  return {
    reason: input.reason,
    cycleIndex: request.cycleIndex,
    limit: request.limit,
    reviewId: request.reviewId,
    approvalId: request.approvalId,
    ...resultOf(submission),
    corrections: request.corrections,
    conflicts: input.conflicts,
    combines: input.reason === "integration" ? input.combines : [],
    // A diagnostic rerun names the checks it suspects. Every other cycle carries them all.
    checks:
      input.reason === "diagnostic"
        ? checks.filter((one) => input.checks.includes(one.name))
        : checks,
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
  const answers = reviewOfCycle(db, { input, submission });
  let accepted: ReworkCorrection[] = [];
  if (input.reason === "diagnostic") {
    const diagnostic = diagnosticGate(submission, input.checks);
    if (diagnostic.status !== "ok") {
      return diagnostic;
    }
  } else if (answers !== null) {
    const gate = reviewGate(db, { reviewId: answers, submission, input });
    if (gate.status !== "ok") {
      return gate;
    }
    accepted = gate.corrections;
  }

  const strayConflict = conflictGate(db, {
    assignmentId: row.id,
    input,
    corrections: accepted,
  });
  if (strayConflict !== null) {
    return strayConflict;
  }

  const budget = spendBudget(db, { assignmentId: row.id, reason: input.reason, now: request.now });
  if (budget.status === "limit-reached") {
    return budget;
  }

  const { cycleIndex, limit, approvalId } = budget;
  const brief = briefOf({
    input,
    submission,
    reviewId: answers,
    cycleIndex,
    limit,
    approvalId,
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

  const revision = moveAssignment(db, { row, state: "rework", now: request.now });

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

export type InvalidationCycle = {
  cycleId: string;
  cycleIndex: number;
  limit: number;
  approvalId: string | null;
  briefIdentity: string;
  landedCommit: string | null;
  startCommit: string | null;
};

export type InvalidationCycleOutcome =
  | { status: "opened"; cycle: InvalidationCycle }
  | Extract<ReworkOutcome, { status: "limit-reached" }>;

/**
 * Opens the cycle that corrects one invalidated result (ADR 0008).
 * The defect, the accepted submission, and the landed commit are its content, so the fresh
 * Operative never has to find the defect again. It spends the same budget as every other
 * correction, so a spent budget records a direction request and opens nothing.
 */
export function openInvalidationCycle(
  db: CrewWriter,
  request: {
    cycleId: string;
    assignmentId: string;
    invalidationId: string;
    defect: DefectInput;
    submission: SubmissionRow;
    now: string;
  },
): InvalidationCycleOutcome {
  const budget = spendBudget(db, {
    assignmentId: request.assignmentId,
    reason: "invalidation",
    now: request.now,
  });
  if (budget.status === "limit-reached") {
    return budget;
  }

  const result = resultOf(request.submission);
  // The correction takes the place of the commit on the branch that carries the result, so it
  // starts on the parent of that commit there (ADR 0020).
  const landed = landedCommitOf(db, request.submission);
  const invalidation: ReworkInvalidation = {
    invalidationId: request.invalidationId,
    defect: request.defect,
    landedCommit: landed?.commit ?? null,
    startCommit: landed?.parent ?? null,
  };
  const brief: ReworkBriefRecord = {
    reason: "invalidation",
    cycleIndex: budget.cycleIndex,
    limit: budget.limit,
    approvalId: budget.approvalId,
    reviewId: null,
    ...result,
    corrections: [],
    conflicts: [],
    combines: [],
    checks: storedChecks(request.submission.checks),
    invalidation,
  };
  const briefIdentity = identityOf(brief);
  insertCycle(db, {
    cycleId: request.cycleId,
    assignmentId: request.assignmentId,
    submissionId: request.submission.id,
    reviewId: null,
    reason: "invalidation",
    cycleIndex: budget.cycleIndex,
    brief,
    briefIdentity,
    approvalId: budget.approvalId,
    now: request.now,
  });

  return {
    status: "opened",
    cycle: {
      cycleId: request.cycleId,
      cycleIndex: budget.cycleIndex,
      limit: budget.limit,
      approvalId: budget.approvalId,
      briefIdentity,
      landedCommit: invalidation.landedCommit,
      startCommit: invalidation.startCommit,
    },
  };
}
