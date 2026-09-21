import { eq } from "drizzle-orm";
import type { CrewWriter } from "./database.ts";
import { activeAttempt, readAssignment } from "./frontier.ts";
import {
  findingsOf,
  missingAxes,
  reportsOf,
  reviewOfAssignment,
  reviewOfSubmission,
} from "./review.ts";
import { assignments, attempts, submissions } from "./schema.ts";
import type { SubmittedCheck, SubmittedCode } from "./submission-input.ts";
import { latestSubmission, type SubmissionRow } from "./submission.ts";
import { isExecutable, isReview } from "./work-input.ts";

export type AcceptResult =
  | { status: "accepted"; assignmentId: string; attemptId: string | null; revision: number }
  | { status: "unknown-assignment"; assignmentId: string }
  | { status: "stale-revision"; assignmentId: string; recordedRevision: number }
  | { status: "not-claimed"; assignmentId: string; state: string }
  | { status: "attempt-required"; assignmentId: string }
  | { status: "attempt-not-expected"; assignmentId: string }
  | { status: "attempt-mismatch"; assignmentId: string; attemptId: string | null }
  | { status: "submission-required"; assignmentId: string }
  | { status: "submission-mismatch"; assignmentId: string; recordedSubmissionId: string }
  | {
      status: "review-incomplete";
      assignmentId: string;
      reviewId: string | null;
      state: string;
      blocker: unknown;
    }
  | { status: "review-axes-incomplete"; assignmentId: string; reviewId: string; missing: string[] }
  | { status: "findings-undisposed"; assignmentId: string; reviewId: string; findingIds: string[] }
  | { status: "rework-pending"; assignmentId: string; reviewId: string; findingIds: string[] }
  | {
      status: "checks-unproven";
      assignmentId: string;
      checks: Array<{ name: string; outcome: string }>;
    }
  | { status: "pr-authority-missing"; assignmentId: string; detail: string }
  | { status: "pr-head-required"; assignmentId: string; headCommit: string }
  | { status: "pr-head-changed"; assignmentId: string; recorded: string; stated: string };

type AcceptRequest = {
  assignmentId: string;
  attemptId: string | null;
  revision: number;
  submissionId: string | null;
  prHead: string | null;
  now: string;
};

/** Every recorded check must have passed. A flaky or unrun check proves nothing. */
function unprovenChecks(submission: SubmissionRow): Array<{ name: string; outcome: string }> {
  const checks: SubmittedCheck[] = JSON.parse(submission.checks);
  return checks
    .filter((check) => check.outcome !== "passed")
    .map((check) => ({ name: check.name, outcome: check.outcome }));
}

/**
 * The review gates of one code or non-code submission.
 * Every gate is a recorded fact, so a process that exited, a missing input, an unavailable
 * review capability, a failed check, or a moved pull request head can never read as acceptance.
 */
function reviewGate(
  db: CrewWriter,
  request: { submission: SubmissionRow; prHead: string | null },
): AcceptResult | null {
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
  const undisposed = findings.filter((one) => one.disposition === null).map((one) => one.id);
  if (undisposed.length > 0) {
    return {
      status: "findings-undisposed",
      assignmentId: submission.assignmentId,
      reviewId: review.id,
      findingIds: undisposed,
    };
  }

  // An accepted correction is delegated rework, so it blocks acceptance until that work lands.
  const corrections = findings
    .filter((one) => one.disposition === "corrected")
    .map((one) => one.id);
  if (corrections.length > 0) {
    return {
      status: "rework-pending",
      assignmentId: submission.assignmentId,
      reviewId: review.id,
      findingIds: corrections,
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

  if (submission.code === null) {
    return null;
  }

  const code: SubmittedCode = JSON.parse(submission.code);
  if (code.pullRequest.status !== "open") {
    return {
      status: "pr-authority-missing",
      assignmentId: submission.assignmentId,
      detail: code.pullRequest.detail,
    };
  }
  // The Operator states the head it read, so a pull request that moved after review is refused.
  if (request.prHead === null) {
    return {
      status: "pr-head-required",
      assignmentId: submission.assignmentId,
      headCommit: code.pullRequest.headCommit,
    };
  }
  if (request.prHead !== code.pullRequest.headCommit) {
    return {
      status: "pr-head-changed",
      assignmentId: submission.assignmentId,
      recorded: code.pullRequest.headCommit,
      stated: request.prHead,
    };
  }

  return null;
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

  const revision = row.revision + 1;

  if (!isExecutable(row.kind)) {
    if (request.attemptId !== null) {
      return { status: "attempt-not-expected", assignmentId: row.id };
    }
    if (row.state !== "registered") {
      return { status: "not-claimed", assignmentId: row.id, state: row.state };
    }

    db.update(assignments)
      .set({ state: "accepted", revision, updatedAt: request.now })
      .where(eq(assignments.id, row.id))
      .run();
    return { status: "accepted", assignmentId: row.id, attemptId: null, revision };
  }

  if (request.attemptId === null) {
    return { status: "attempt-required", assignmentId: row.id };
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
        blocker: review.blocker === null ? null : JSON.parse(review.blocker),
      };
    }

    db.update(attempts)
      .set({ state: "accepted", endedAt: request.now, revision: live.revision + 1 })
      .where(eq(attempts.id, live.id))
      .run();
    db.update(assignments)
      .set({ state: "accepted", revision, updatedAt: request.now })
      .where(eq(assignments.id, row.id))
      .run();
    return { status: "accepted", assignmentId: row.id, attemptId: live.id, revision };
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

  const blocked = reviewGate(db, { submission, prHead: request.prHead });
  if (blocked !== null) {
    return blocked;
  }

  db.update(attempts)
    .set({ state: "accepted", endedAt: request.now })
    .where(eq(attempts.id, submission.attemptId))
    .run();
  db.update(submissions)
    .set({ state: "accepted", revision: submission.revision + 1, updatedAt: request.now })
    .where(eq(submissions.id, submission.id))
    .run();
  db.update(assignments)
    .set({ state: "accepted", revision, updatedAt: request.now })
    .where(eq(assignments.id, row.id))
    .run();

  return { status: "accepted", assignmentId: row.id, attemptId: submission.attemptId, revision };
}
