import { eq } from "drizzle-orm";
import { type AssignmentRow, readAssignment } from "./assignment.ts";
import {
  type AcceptFacts,
  type AcceptRefusal,
  Assignment,
  type AssignmentNext,
} from "./assignment-machine.ts";
import { endAttempt, readAttempt } from "./attempt.ts";
import { Attempt } from "./attempt-machine.ts";
import type { CrewReader, CrewWriter } from "./database.ts";
import { activeAttempt, unmetDependencies } from "./frontier.ts";
import { findingsOf, reportsOf, reviewOfAssignment, reviewOfSubmission } from "./review.ts";
import { directionRecordOf, openDirectionsOf } from "./direction.ts";
import { acceptAndRelease, openPauses } from "./invalidate.ts";
import { outsideChangesOfSubmission } from "./outside-changes.ts";
import {
  checkPlanningRecord,
  insertPlanningRecord,
  type PreparedRecord,
} from "./planning-record.ts";
import type { StoredEntry } from "./planning-input.ts";
import type { LandingRefusal, MoveNext } from "./branch-move.ts";
import { insertLandingIntent, type LandingPlan, recordedTipOf, recordLanding } from "./landing.ts";
import { intendedLandingOf, replacedLandingOf } from "./landing-record.ts";
import { applyRewrite } from "./rewrite.ts";
import { blockingQuestionOf } from "./questions.ts";
import { submissions } from "./schema.ts";
import { storedCode } from "./submission-input.ts";
import { latestSubmission, reviewedBaseOf, type SubmissionRow } from "./submission.ts";
import { isReview } from "./work-input.ts";
import { registerBranchReview, type RegisteredBranchReview } from "./branch-review.ts";

export type AcceptResult =
  | {
      status: "accepted";
      assignmentId: string;
      attemptId: string | null;
      revision: number;
      planningRecordId: string | null;
      // The landing of a code result, or null for every other acceptance.
      landing: AcceptedLanding | null;
      // The branch review this acceptance registered, because it made the branch final.
      branchReview: RegisteredBranchReview | null;
    }
  | { status: "unknown-assignment"; assignmentId: string }
  | AcceptRefusal
  | {
      // Every other gate passed, so a code result now plans its landing (ADR 0020).
      status: "landing-required";
      assignmentId: string;
      sourceId: string;
      submissionId: string;
      commit: string;
      reviewedBase: string;
      // The landing this result replaces when it is a correction of a landed commit, which lands
      // through a rewrite in place (ADR 0020), or null for an ordinary landing.
      replaces: string | null;
    }
  | { status: "landing-intended"; assignmentId: string; landingId: string }
  | LandingRefusal;

/** The landing of one accepted code result, as acceptance reports it. */
export type AcceptedLanding = {
  landingId: string;
  branch: string;
  kind: string;
  from: string;
  to: string;
  // The commit on the branch that carries the accepted result.
  landed: string;
  // What a rewrite did to the later commits, or null for an ordinary landing.
  rewrite: {
    replaced: string;
    relanded: Array<{ assignmentId: string; from: string; to: string }>;
    takenOut: Array<{ assignmentId: string; commit: string; cause: string }>;
  } | null;
};

/**
 * What one acceptance does at the landing step, the last gate of a code result. A probe stops
 * there and records nothing, an intent records the planned move before the branch moves, and a
 * record completes the acceptance after the move (ADR 0005, ADR 0020).
 */
export type LandingStep =
  | { kind: "probe" }
  | { kind: "intend"; landingId: string; plan: LandingPlan }
  | { kind: "record"; landingId: string; intended: boolean; plan: LandingPlan; next: MoveNext };

type AcceptRequest = {
  assignmentId: string;
  attemptId: string | null;
  revision: number;
  submissionId: string | null;
  landing: LandingStep;
  record: PreparedRecord | null;
  now: string;
};

/**
 * The landing step of one code result. Its plan and its move are Git effects outside this
 * transaction, so the caller plans first, records the intent here, moves the branch, and then
 * records the outcome here with the acceptance. The recorded tip is read again here, so a plan
 * made on a tip that another acceptance moved is never recorded.
 */
function landingStep(
  db: CrewWriter,
  request: { row: AssignmentRow; submission: SubmissionRow; step: LandingStep; now: string },
): { status: "landed"; landing: AcceptedLanding | null } | AcceptResult {
  const { row, submission, step } = request;
  // A correction of a landed commit takes the place of that commit through a rewrite in place.
  const replaced = replacedLandingOf(db, { assignmentId: row.id, submissionId: submission.id });
  if (step.kind === "probe") {
    return {
      status: "landing-required",
      assignmentId: row.id,
      sourceId: row.sourceId,
      submissionId: submission.id,
      commit: storedCode(submission.code ?? "").resultCommit,
      reviewedBase: reviewedBaseOf(db, submission) ?? "",
      replaces: replaced?.id ?? null,
    };
  }

  const intended = intendedLandingOf(db, row.sourceId);
  const own = intended !== null && intended.id === step.landingId;
  if (intended !== null && !own) {
    return {
      status: "landing-pending",
      assignmentId: row.id,
      landingId: intended.id,
      pendingAssignmentId: intended.assignmentId,
    };
  }
  const recordedTip = recordedTipOf(db, row.sourceId);
  if (!own && recordedTip !== step.plan.from) {
    return {
      status: "landing-tip-changed",
      assignmentId: row.id,
      planned: step.plan.from,
      recordedTip,
    };
  }

  const fields = {
    landingId: step.landingId,
    sourceId: row.sourceId,
    assignmentId: row.id,
    submissionId: submission.id,
    plan: step.plan,
    now: request.now,
  };
  if (step.kind === "intend") {
    insertLandingIntent(db, fields);
    return { status: "landing-intended", assignmentId: row.id, landingId: step.landingId };
  }
  recordLanding(db, { ...fields, intended: own, next: step.next });
  const { rewrite } = step.plan;
  if (rewrite !== null) {
    applyRewrite(db, { rewrite, now: request.now });
  }
  return {
    status: "landed",
    landing: {
      landingId: step.landingId,
      branch: step.plan.name,
      kind: step.plan.kind,
      from: step.plan.from,
      to: step.plan.to,
      landed: step.plan.landed,
      rewrite:
        rewrite === null
          ? null
          : {
              replaced: rewrite.replacedCommit,
              relanded: rewrite.relanded.map(({ assignmentId, from, to }) => ({
                assignmentId,
                from,
                to,
              })),
              takenOut: rewrite.takenOut.map(({ assignmentId, commit, cause }) => ({
                assignmentId,
                commit,
                cause,
              })),
            },
    },
  };
}

/** The question that holds one stated attempt, or null when none waits or none is stated. */
function questionOf(db: CrewReader, attemptId: string | null) {
  const open = attemptId === null ? null : blockingQuestionOf(db, attemptId);
  return open === null ? null : { id: open.id, state: open.state };
}

/** The latest submission of one producer, with its review and its outside changes. */
function producedOf(db: CrewReader, row: AssignmentRow) {
  const submission = latestSubmission(db, row.id);
  if (submission === null) {
    return null;
  }
  const review = reviewOfSubmission(db, submission.id);
  return {
    submission,
    review:
      review === null
        ? null
        : { row: review, findings: findingsOf(db, review.id), reports: reportsOf(db, review.id) },
    outside: outsideChangesOfSubmission(db, submission.id),
  };
}

/** What the acceptance of one assignment reads, by the kind of its work. */
function acceptFactsOf(db: CrewReader, row: AssignmentRow, request: AcceptRequest): AcceptFacts {
  const common = {
    row,
    revision: request.revision,
    attemptId: request.attemptId,
    record: request.record,
    directions: openDirectionsOf(db, row.id).map(directionRecordOf),
    invalidated: openPauses(db).get(row.id) ?? [],
  };
  if (row.kind === "planning") {
    const { record } = request;
    return {
      ...common,
      kind: "planning",
      unmet: unmetDependencies(db, row.id),
      checked: record === null ? null : checkPlanningRecord(db, { row, record }),
    };
  }
  const question = questionOf(db, request.attemptId);
  if (isReview(row.kind)) {
    const live = activeAttempt(db, row.id);
    return { ...common, kind: "review", question, live, review: reviewOfAssignment(db, row.id) };
  }
  return {
    ...common,
    kind: "production",
    question,
    submissionId: request.submissionId,
    produced: producedOf(db, row),
  };
}

/** Ends the attempt that produced an accepted result, as the attempt machine decides. */
function acceptAttempt(db: CrewWriter, request: { attemptId: string; now: string }): void {
  const attempt = readAttempt(db, request.attemptId);
  const decided = attempt === null ? null : Attempt.decide("accept", { attempt });
  if (attempt !== null && decided !== null && "next" in decided) {
    endAttempt(db, { attempt, state: decided.next, now: request.now });
  }
}

/**
 * Accepts planning work with no attempt. Its record is written in the same transaction as the
 * acceptance, so an accepted decision always carries what it decided.
 */
function acceptPlanning(
  db: CrewWriter,
  request: {
    row: AssignmentRow;
    next: AssignmentNext["accept"];
    record: PreparedRecord;
    entries: StoredEntry[];
    now: string;
  },
): AcceptResult {
  const { row } = request;
  const revision = acceptAndRelease(db, { row, next: request.next, now: request.now });
  return {
    status: "accepted",
    assignmentId: row.id,
    attemptId: null,
    revision,
    planningRecordId: insertPlanningRecord(db, {
      assignmentId: row.id,
      assignmentRevision: revision,
      entries: request.entries,
      artifacts: request.record.artifacts,
      now: request.now,
    }),
    landing: null,
    branchReview: null,
  };
}

/** Accepts review work once its own reports exist, and ends its attempt. */
function acceptReview(
  db: CrewWriter,
  request: { row: AssignmentRow; attemptId: string; next: AssignmentNext["accept"]; now: string },
): AcceptResult {
  const { row, attemptId, now } = request;
  acceptAttempt(db, { attemptId, now });
  return {
    status: "accepted",
    assignmentId: row.id,
    attemptId,
    revision: acceptAndRelease(db, { row, next: request.next, now }),
    planningRecordId: null,
    landing: null,
    branchReview: null,
  };
}

/**
 * Accepts production work from its reviewed submission. The landing is the last gate and the
 * last effect, so nothing lands that another gate refuses.
 */
function acceptProduction(
  db: CrewWriter,
  request: AcceptRequest & {
    row: AssignmentRow;
    next: AssignmentNext["accept"];
    submission: SubmissionRow;
  },
): AcceptResult {
  const { row, submission, now } = request;
  let landing: AcceptedLanding | null = null;
  if (submission.code !== null) {
    const step = landingStep(db, { row, submission, step: request.landing, now });
    if (step.status !== "landed") {
      return step;
    }
    landing = step.landing;
  }

  acceptAttempt(db, { attemptId: submission.attemptId, now });
  db.update(submissions)
    .set({ state: "accepted", revision: submission.revision + 1, updatedAt: now })
    .where(eq(submissions.id, submission.id))
    .run();

  return {
    status: "accepted",
    assignmentId: row.id,
    attemptId: submission.attemptId,
    revision: acceptAndRelease(db, { row, next: request.next, now }),
    planningRecordId: null,
    landing,
    // The acceptance that makes the integration branch final registers its branch review in the
    // same change, as a submission registers its result review (ADR 0017).
    branchReview: registerBranchReview(db, { sourceId: row.sourceId, now }),
  };
}

/**
 * Records accepted completion, the only state that unblocks a dependent assignment.
 * Planning work is resolved by the Operator with no attempt. Review work is accepted once its
 * own reports exist. Production work is accepted only from its reviewed submission. The
 * assignment machine decides each gate from the facts read here, in its order.
 */
export function acceptAssignment(db: CrewWriter, request: AcceptRequest): AcceptResult {
  const row = readAssignment(db, request.assignmentId);
  if (row === null) {
    return { status: "unknown-assignment", assignmentId: request.assignmentId };
  }
  const facts = acceptFactsOf(db, row, request);
  const decided = Assignment.decide("accept", facts);
  if ("refused" in decided) {
    return decided.refused;
  }

  const { next } = decided;
  if (facts.kind === "planning" && facts.checked?.status === "checked" && facts.record !== null) {
    const { record } = facts;
    return acceptPlanning(db, {
      row,
      next,
      record,
      entries: facts.checked.entries,
      now: request.now,
    });
  }
  if (facts.kind === "review" && request.attemptId !== null) {
    return acceptReview(db, { row, attemptId: request.attemptId, next, now: request.now });
  }
  if (facts.kind !== "production" || facts.produced === null) {
    throw new Error(`The acceptance of ${row.id} passed with no result to accept.`);
  }
  return acceptProduction(db, { ...request, row, next, submission: facts.produced.submission });
}
