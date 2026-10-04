import { eq } from "drizzle-orm";
import { type AssignmentRow, moveAssignment, readAssignment } from "./assignment.ts";
import { endAttempt, readAttempt } from "./attempt.ts";
import type { CrewWriter } from "./database.ts";
import { activeAttempt, unmetDependencies } from "./frontier.ts";
import {
  corrections,
  findingsOf,
  missingAxes,
  reportsOf,
  type ReviewReportRow,
  reviewOfAssignment,
  reviewOfSubmission,
  undisposed,
} from "./review.ts";
import { type DirectionRecord, directionRecordOf, openDirectionsOf } from "./direction.ts";
import { openPauses, resolveInvalidations } from "./invalidate.ts";
import { outsideChangesOfSubmission, undisposedOutside } from "./outside-changes.ts";
import {
  checkPlanningRecord,
  insertPlanningRecord,
  type PreparedRecord,
  type RecordRefusal,
} from "./planning-record.ts";
import type { LandingRefusal, MoveNext } from "./branch-move.ts";
import { insertLandingIntent, type LandingPlan, recordedTipOf, recordLanding } from "./landing.ts";
import { intendedLandingOf, replacedLandingOf } from "./landing-record.ts";
import { applyRewrite } from "./rewrite.ts";
import { blockingQuestionOf } from "./questions.ts";
import { submissions } from "./schema.ts";
import { type ReviewBlocker, storedBlocker, storedObservedChecks } from "./review-input.ts";
import { storedChecks, storedCode } from "./submission-input.ts";
import { latestSubmission, reviewedBaseOf, type SubmissionRow } from "./submission.ts";
import { isExecutable, isReview } from "./work-input.ts";
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
  | { status: "stale-revision"; assignmentId: string; recordedRevision: number }
  | { status: "not-claimed"; assignmentId: string; state: string }
  | { status: "direction-required"; assignmentId: string; directions: DirectionRecord[] }
  | { status: "input-invalidated"; assignmentId: string; invalidated: string[] }
  | { status: "attempt-required"; assignmentId: string }
  | { status: "attempt-not-expected"; assignmentId: string }
  | {
      status: "dependency-pending";
      assignmentId: string;
      dependencies: Array<{ assignmentId: string; state: string }>;
    }
  | { status: "planning-record-required"; assignmentId: string }
  | { status: "planning-record-not-expected"; assignmentId: string }
  | RecordRefusal
  | { status: "attempt-mismatch"; assignmentId: string; attemptId: string | null }
  | { status: "question-open"; assignmentId: string; questionId: string; state: string }
  | { status: "submission-required"; assignmentId: string }
  | { status: "submission-mismatch"; assignmentId: string; recordedSubmissionId: string }
  | {
      status: "review-incomplete";
      assignmentId: string;
      reviewId: string | null;
      state: string;
      blocker: ReviewBlocker | null;
    }
  | { status: "review-axes-incomplete"; assignmentId: string; reviewId: string; missing: string[] }
  | { status: "findings-undisposed"; assignmentId: string; reviewId: string; findingIds: string[] }
  | { status: "rework-pending"; assignmentId: string; reviewId: string; findingIds: string[] }
  | {
      status: "checks-unproven";
      assignmentId: string;
      checks: Array<{ name: string; outcome: string }>;
    }
  | {
      status: "checks-contradicted";
      assignmentId: string;
      reviewId: string;
      checks: Array<{ name: string; axis: string; recorded: string; observed: string }>;
    }
  | {
      status: "outside-changes-undisposed";
      assignmentId: string;
      submissionId: string;
      changeIds: string[];
      // How many of them touch a security permission, which only the user releases.
      security: number;
    }
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
 * Records accepted completion and releases what an earlier defect on this work paused.
 * A corrected result is the condition those dependents waited on, so nothing waits for a
 * second decision that says the same thing twice.
 */
function acceptRow(db: CrewWriter, request: { row: AssignmentRow; now: string }): number {
  const revision = moveAssignment(db, { row: request.row, state: "accepted", now: request.now });
  resolveInvalidations(db, { assignmentId: request.row.id, now: request.now });
  return revision;
}

/** One assignment that still waits on an answer. Only that work waits, and it is not accepted. */
function openQuestion(assignmentId: string, waiting: { id: string; state: string }): AcceptResult {
  return { status: "question-open", assignmentId, questionId: waiting.id, state: waiting.state };
}

/** The recorded blocker of one review, or null while it has none. */
function blockerOf(stored: string | null): ReviewBlocker | null {
  return stored === null ? null : storedBlocker(stored);
}

/** Every recorded check must have passed. A flaky or unrun check proves nothing. */
function unprovenChecks(submission: SubmissionRow): Array<{ name: string; outcome: string }> {
  return storedChecks(submission.checks)
    .filter((check) => check.outcome !== "passed")
    .map((check) => ({ name: check.name, outcome: check.outcome }));
}

/**
 * Every check outcome a review observed that the producer did not record the same way.
 * A reviewer that ran a command for itself is independent evidence, so a producer that wrote
 * `passed` over a failing or flaky run cannot reach acceptance.
 */
function contradictedChecks(
  submission: SubmissionRow,
  reports: ReviewReportRow[],
): Array<{ name: string; axis: string; recorded: string; observed: string }> {
  const recorded = new Map(
    storedChecks(submission.checks).map((check) => [check.name, check.outcome]),
  );

  return reports.flatMap((report) =>
    storedObservedChecks(report.observedChecks).flatMap((observed) => {
      const producer = recorded.get(observed.name) ?? "not-recorded";
      return observed.outcome === "passed" && producer === "passed"
        ? []
        : [
            {
              name: observed.name,
              axis: report.axis,
              recorded: producer,
              observed: observed.outcome,
            },
          ];
    }),
  );
}

/**
 * The review gates of one code or non-code submission.
 * Every gate is a recorded fact, so a process that exited, a missing input, an unavailable
 * review capability, or a failed check can never read as acceptance.
 */
function reviewGate(db: CrewWriter, request: { submission: SubmissionRow }): AcceptResult | null {
  const { submission } = request;
  const review = reviewOfSubmission(db, submission.id);
  if (review === null || review.state !== "reported") {
    return {
      status: "review-incomplete",
      assignmentId: submission.assignmentId,
      reviewId: review?.id ?? null,
      state: review?.state ?? "none",
      blocker:
        review?.blocker === undefined || review.blocker === null
          ? null
          : JSON.parse(review.blocker),
    };
  }

  const missing = missingAxes(reportsOf(db, review.id));
  if (missing.length > 0) {
    return {
      status: "review-axes-incomplete",
      assignmentId: submission.assignmentId,
      reviewId: review.id,
      missing,
    };
  }

  const findings = findingsOf(db, review.id);
  const open = undisposed(findings);
  if (open.length > 0) {
    return {
      status: "findings-undisposed",
      assignmentId: submission.assignmentId,
      reviewId: review.id,
      findingIds: open.map((one) => one.id),
    };
  }

  // An accepted correction is delegated rework, so it blocks acceptance until that work lands.
  const pending = corrections(findings);
  if (pending.length > 0) {
    return {
      status: "rework-pending",
      assignmentId: submission.assignmentId,
      reviewId: review.id,
      findingIds: pending.map((one) => one.id),
    };
  }

  const unproven = unprovenChecks(submission);
  if (unproven.length > 0) {
    return {
      status: "checks-unproven",
      assignmentId: submission.assignmentId,
      checks: unproven,
    };
  }

  // What a reviewer ran for itself outranks what the producer wrote about its own work.
  const contradicted = contradictedChecks(submission, reportsOf(db, review.id));
  if (contradicted.length > 0) {
    return {
      status: "checks-contradicted",
      assignmentId: submission.assignmentId,
      reviewId: review.id,
      checks: contradicted,
    };
  }

  return null;
}

/**
 * Accepts planning work with no attempt. Its record is checked and written in the same
 * transaction as the acceptance, so an accepted decision always carries what it decided.
 */
function acceptPlanning(
  db: CrewWriter,
  request: AcceptRequest & { row: AssignmentRow },
): AcceptResult {
  const { row } = request;
  if (request.attemptId !== null) {
    return { status: "attempt-not-expected", assignmentId: row.id };
  }
  // An invalidated decision is answered by deciding again, and only that new acceptance
  // releases the dependents the invalidation paused.
  if (row.state !== "registered" && row.state !== "invalidated") {
    return { status: "not-claimed", assignmentId: row.id, state: row.state };
  }

  // A decision taken before its own inputs are accepted is a decision on inputs that may still
  // change, so planning work waits on its dependencies as dispatched work does.
  const unmet = unmetDependencies(db, row.id);
  if (unmet.length > 0) {
    return { status: "dependency-pending", assignmentId: row.id, dependencies: unmet };
  }

  // The record is what the planning work gives to the work that waits on it, so an acceptance
  // that records nothing would unblock a dependent that then receives nothing.
  if (request.record === null) {
    return { status: "planning-record-required", assignmentId: row.id };
  }
  const checked = checkPlanningRecord(db, { row, record: request.record });
  if (checked.status !== "checked") {
    return checked;
  }

  const revision = acceptRow(db, { row, now: request.now });
  return {
    status: "accepted",
    assignmentId: row.id,
    attemptId: null,
    revision,
    planningRecordId: insertPlanningRecord(db, {
      assignmentId: row.id,
      assignmentRevision: revision,
      entries: checked.entries,
      artifacts: request.record.artifacts,
      now: request.now,
    }),
    landing: null,
    branchReview: null,
  };
}

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

/**
 * Records accepted completion, the only state that unblocks a dependent assignment.
 * Planning work is resolved by the Operator with no attempt. Review work is accepted once its
 * own reports exist. Production work is accepted only from its reviewed submission.
 */
export function acceptAssignment(db: CrewWriter, request: AcceptRequest): AcceptResult {
  const row = readAssignment(db, request.assignmentId);
  if (row === null) {
    return { status: "unknown-assignment", assignmentId: request.assignmentId };
  }
  if (row.revision !== request.revision) {
    return { status: "stale-revision", assignmentId: row.id, recordedRevision: row.revision };
  }

  // A reached limit is work that waits on the user. Accepting it here would settle by silence
  // what the crew already proved it could not settle by itself.
  const waiting = openDirectionsOf(db, row.id);
  if (waiting.length > 0) {
    return {
      status: "direction-required",
      assignmentId: row.id,
      directions: waiting.map(directionRecordOf),
    };
  }

  // Work that read an invalidated result is paused, so accepting it would carry the defect on.
  const invalid = openPauses(db).get(row.id) ?? [];
  if (invalid.length > 0) {
    return { status: "input-invalidated", assignmentId: row.id, invalidated: invalid };
  }

  if (!isExecutable(row.kind)) {
    return acceptPlanning(db, { ...request, row });
  }

  // Only planning work records a decision. Executable work hands over its result instead.
  if (request.record !== null) {
    return { status: "planning-record-not-expected", assignmentId: row.id };
  }

  if (request.attemptId === null) {
    return { status: "attempt-required", assignmentId: row.id };
  }

  // Work that still waits on an answer is not finished work, so it is never accepted.
  // This reads ahead of every later gate, because an unanswered question is what the caller
  // must settle first and it holds the attempt before it can even hand over a result.
  const open = blockingQuestionOf(db, request.attemptId);
  if (open !== null) {
    return openQuestion(row.id, open);
  }

  if (isReview(row.kind)) {
    if (row.state !== "claimed") {
      return { status: "not-claimed", assignmentId: row.id, state: row.state };
    }

    const live = activeAttempt(db, row.id);
    if (live === null || live.id !== request.attemptId) {
      return { status: "attempt-mismatch", assignmentId: row.id, attemptId: live?.id ?? null };
    }

    // A review of a submission is complete when its own reports exist. It submits no result of
    // its own, so the review chain stops here instead of starting another review.
    // Review work a source registered by hand carries no submission, so it accepts like any
    // other claimed assignment.
    const review = reviewOfAssignment(db, row.id);
    if (review !== null && review.state !== "reported") {
      return {
        status: "review-incomplete",
        assignmentId: row.id,
        reviewId: review.id,
        state: review.state,
        blocker: blockerOf(review.blocker),
      };
    }

    endAttempt(db, { attempt: live, state: "accepted", now: request.now });
    return {
      status: "accepted",
      assignmentId: row.id,
      attemptId: live.id,
      revision: acceptRow(db, { row, now: request.now }),
      planningRecordId: null,
      landing: null,
      branchReview: null,
    };
  }

  // Production work reaches acceptance only through a submission, so a claimed assignment that
  // handed over nothing cannot be accepted.
  if (row.state !== "awaiting-review") {
    return { status: "not-claimed", assignmentId: row.id, state: row.state };
  }

  const submission = latestSubmission(db, row.id);
  if (submission === null) {
    return { status: "submission-required", assignmentId: row.id };
  }
  if (request.submissionId === null || request.submissionId !== submission.id) {
    return {
      status: "submission-mismatch",
      assignmentId: row.id,
      recordedSubmissionId: submission.id,
    };
  }
  if (submission.attemptId !== request.attemptId) {
    return { status: "attempt-mismatch", assignmentId: row.id, attemptId: submission.attemptId };
  }

  const blocked = reviewGate(db, { submission });
  if (blocked !== null) {
    return blocked;
  }

  // A recorded fact never passes by silence (ADR 0007), so each outside change is answered.
  const outside = undisposedOutside(outsideChangesOfSubmission(db, submission.id));
  if (outside.length > 0) {
    return {
      status: "outside-changes-undisposed",
      assignmentId: row.id,
      submissionId: submission.id,
      changeIds: outside.map((one) => one.id),
      security: outside.filter((one) => one.security === 1).length,
    };
  }

  // The landing is the last gate and the last effect, so nothing lands that another gate refuses.
  let landing: AcceptedLanding | null = null;
  if (submission.code !== null) {
    const step = landingStep(db, { row, submission, step: request.landing, now: request.now });
    if (step.status !== "landed") {
      return step;
    }
    landing = step.landing;
  }

  const submitted = readAttempt(db, submission.attemptId);
  if (submitted !== null) {
    endAttempt(db, { attempt: submitted, state: "accepted", now: request.now });
  }
  db.update(submissions)
    .set({ state: "accepted", revision: submission.revision + 1, updatedAt: request.now })
    .where(eq(submissions.id, submission.id))
    .run();

  const revision = acceptRow(db, { row, now: request.now });
  return {
    status: "accepted",
    assignmentId: row.id,
    attemptId: submission.attemptId,
    revision,
    planningRecordId: null,
    landing,
    // The acceptance that makes the integration branch final registers its branch review in the
    // same change, as a submission registers its result review (ADR 0017).
    branchReview: registerBranchReview(db, { sourceId: row.sourceId, now: request.now }),
  };
}
