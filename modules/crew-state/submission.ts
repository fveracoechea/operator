import { eq } from "drizzle-orm";
import type { CrewReader, CrewWriter } from "./database.ts";
import { type AttemptRow, endAttempt } from "./attempt.ts";
import {
  type AssignmentRow,
  insertAssignment,
  moveAssignment,
  nextOrderIndex,
} from "./assignment.ts";
import { identityOf } from "./identity.ts";
import { assignments, reviews, submissions } from "./schema.ts";
import { REVIEW_AXES } from "./review.ts";
import { closeCycle, openCycleOf } from "./rework.ts";
import { storedRequirements } from "./work-input.ts";
import type { SubmissionInput } from "./submission-input.ts";
import type { StoredArtifact } from "./submission-store.ts";

export type SubmissionRow = typeof submissions.$inferSelect;

/** The Operator commands every reviewer runs, whatever the result it reads. */
const REVIEWER_COMMANDS = ["operator attempt acknowledge", "operator review report"];

export type SubmitOutcome =
  | {
      status: "submitted";
      submissionId: string;
      assignmentId: string;
      attemptId: string;
      revision: number;
      identity: string;
      reviewId: string;
      reviewAssignmentId: string;
      reviewSourceKey: string;
      // The delegated cycle this result answers, when the assignment was in rework.
      reworkCycleId: string | null;
    }
  | { status: "review-result-not-submitted"; assignmentId: string }
  | { status: "planning-only"; assignmentId: string; kind: string }
  | { status: "not-claimed"; assignmentId: string; state: string }
  | { status: "stale-revision"; assignmentId: string; recordedRevision: number }
  | { status: "source-revision-changed"; assignmentId: string; recordedRevision: string }
  | { status: "requirements-changed"; assignmentId: string; recordedIdentity: string }
  | { status: "already-submitted"; attemptId: string; submissionId: string };

export function readSubmission(db: CrewReader, id: string): SubmissionRow | null {
  return db.select().from(submissions).where(eq(submissions.id, id)).all()[0] ?? null;
}

export function submissionOfAttempt(db: CrewReader, attemptId: string): SubmissionRow | null {
  return db.select().from(submissions).where(eq(submissions.attemptId, attemptId)).all()[0] ?? null;
}

/** Every submission of one assignment, oldest first. Rework submits again under a new revision. */
export function submissionsOf(db: CrewReader, assignmentId: string): SubmissionRow[] {
  return db
    .select()
    .from(submissions)
    .where(eq(submissions.assignmentId, assignmentId))
    .all()
    .toSorted((left, right) => left.assignmentRevision - right.assignmentRevision);
}

/** The most recent submission of one assignment. Rework submits again under a new revision. */
export function latestSubmission(db: CrewReader, assignmentId: string): SubmissionRow | null {
  return submissionsOf(db, assignmentId).at(-1) ?? null;
}

/** The identity of the acceptance requirements one assignment holds. */
function requirementsIdentityOf(assignment: AssignmentRow): string {
  return identityOf(storedRequirements(assignment.acceptanceRequirements));
}

/**
 * Registers the review assignment of one submission.
 * Review is ordinary crew work: it is claimed, dispatched, and accounted for through the same
 * frontier, so the reviewer holds one Herdr slot and its own worktree.
 */
function registerReview(
  db: CrewWriter,
  request: {
    producer: AssignmentRow;
    submissionId: string;
    submissionIdentity: string;
    reviewId: string;
    input: SubmissionInput;
    artifacts: StoredArtifact[];
    now: string;
  },
): { assignmentId: string; sourceKey: string } {
  const held = db
    .select()
    .from(assignments)
    .where(eq(assignments.sourceId, request.producer.sourceId))
    .all();
  const round =
    held.filter((row) => row.sourceKey.startsWith(`${request.producer.sourceKey}#review.`)).length +
    1;
  const sourceKey = `${request.producer.sourceKey}#review.${round}`;
  // A reviewer reports through the CLI, so the brief authorizes those commands as well as the
  // checks it may re-run. A result that recorded no check still leaves the reviewer able to report.
  const commands = [
    ...REVIEWER_COMMANDS,
    ...new Set(request.input.checks.map((one) => one.command)),
  ];

  const fixedInputs = [
    {
      name: "submission",
      kind: "value",
      value: request.submissionId,
      contentIdentity: request.submissionIdentity,
    },
    {
      name: "result-kind",
      kind: "value",
      value: request.input.resultKind,
      contentIdentity: null,
    },
    ...request.artifacts.map((artifact) => ({
      name: artifact.name,
      kind: artifact.kind,
      value: artifact.storedPath ?? artifact.value,
      contentIdentity: artifact.contentIdentity,
    })),
  ];

  const row = insertAssignment(
    db,
    {
      sourceId: request.producer.sourceId,
      sourceKey,
      sourceRevision: request.producer.sourceRevision,
      title: `Review ${request.producer.title}`,
      kind: "review",
      orderIndex: nextOrderIndex(held),
      approvedScope: `Review submission ${request.submissionId} of assignment ${request.producer.id} on the Standards and Spec axes.`,
      acceptanceRequirements: [
        `Record one Standards report and one Spec report for submission ${request.submissionId}.`,
        "Run both axes as native sub-agents of this host, in parallel and in separate contexts.",
        "Never edit, commit, push, or rework the submitted result.",
      ],
      // A reviewer writes its own report and nothing else, so rework can never hide inside it.
      permissions: {
        writePaths: [".operator/local/"],
        allowedCommands: commands,
        network: false,
      },
      fixedInputs,
    },
    request.now,
  );

  db.insert(reviews)
    .values({
      id: request.reviewId,
      submissionId: request.submissionId,
      assignmentId: row.id,
      axes: JSON.stringify(REVIEW_AXES),
      state: "registered",
      host: null,
      subAgents: null,
      blocker: null,
      reportedAt: null,
      revision: 1,
      createdAt: request.now,
      updatedAt: request.now,
    })
    .run();

  return { assignmentId: row.id, sourceKey };
}

/**
 * Records one fixed result and hands it to a separate review.
 * The assignment moves to awaiting review, never to accepted completion, and the attempt ends,
 * so the crew slot it held becomes free for the reviewer.
 */
export function submitResult(
  db: CrewWriter,
  request: {
    attempt: AttemptRow;
    assignment: AssignmentRow;
    input: SubmissionInput;
    artifacts: StoredArtifact[];
    submissionId: string;
    reviewId: string;
    now: string;
  },
): SubmitOutcome {
  const { assignment, attempt, input } = request;

  if (assignment.kind === "review") {
    // A review report is not a submitted result, so it never starts another review.
    return { status: "review-result-not-submitted", assignmentId: assignment.id };
  }
  if (assignment.kind !== "production") {
    return { status: "planning-only", assignmentId: assignment.id, kind: assignment.kind };
  }
  if (assignment.state !== "claimed") {
    return { status: "not-claimed", assignmentId: assignment.id, state: assignment.state };
  }
  if (assignment.revision !== input.assignmentRevision) {
    return {
      status: "stale-revision",
      assignmentId: assignment.id,
      recordedRevision: assignment.revision,
    };
  }
  if (assignment.sourceRevision !== input.sourceRevision) {
    return {
      status: "source-revision-changed",
      assignmentId: assignment.id,
      recordedRevision: assignment.sourceRevision,
    };
  }

  const requirements = requirementsIdentityOf(assignment);
  if (requirements !== input.requirementsIdentity) {
    return {
      status: "requirements-changed",
      assignmentId: assignment.id,
      recordedIdentity: requirements,
    };
  }

  const held = submissionOfAttempt(db, attempt.id);
  if (held !== null) {
    return { status: "already-submitted", attemptId: attempt.id, submissionId: held.id };
  }

  const artifacts = request.artifacts;
  const identity = identityOf({
    assignmentId: assignment.id,
    attemptId: attempt.id,
    resultKind: input.resultKind,
    assignmentRevision: input.assignmentRevision,
    sourceRevision: input.sourceRevision,
    requirementsIdentity: input.requirementsIdentity,
    artifacts,
    checks: input.checks,
    concerns: input.concerns,
    decisions: input.decisions,
    code: input.code ?? null,
  });

  db.insert(submissions)
    .values({
      id: request.submissionId,
      assignmentId: assignment.id,
      attemptId: attempt.id,
      resultKind: input.resultKind,
      assignmentRevision: input.assignmentRevision,
      sourceRevision: input.sourceRevision,
      requirementsIdentity: input.requirementsIdentity,
      artifacts: JSON.stringify(artifacts),
      artifactsIdentity: identityOf(artifacts),
      checks: JSON.stringify(input.checks),
      concerns: JSON.stringify(input.concerns),
      decisions: JSON.stringify(input.decisions),
      code: input.code === null ? null : JSON.stringify(input.code),
      // A code review starts from the exact commit the result lives on, never a moving branch.
      reviewBase: input.code?.resultCommit ?? null,
      identity,
      state: "awaiting-review",
      revision: 1,
      submittedAt: request.now,
      updatedAt: request.now,
    })
    .run();

  // A combined revision closes the cycle it answers, and names the fresh Operative that did it.
  const cycle = openCycleOf(db, assignment.id);
  if (cycle !== null) {
    closeCycle(db, { cycle, attemptId: attempt.id, now: request.now });
  }

  endAttempt(db, { attempt, state: "submitted", now: request.now });

  const revision = moveAssignment(db, {
    row: assignment,
    state: "awaiting-review",
    now: request.now,
  });

  const registered = registerReview(db, {
    producer: assignment,
    submissionId: request.submissionId,
    submissionIdentity: identity,
    reviewId: request.reviewId,
    input,
    artifacts,
    now: request.now,
  });

  return {
    status: "submitted",
    submissionId: request.submissionId,
    assignmentId: assignment.id,
    attemptId: attempt.id,
    revision,
    identity,
    reviewId: request.reviewId,
    reviewAssignmentId: registered.assignmentId,
    reviewSourceKey: registered.sourceKey,
    reworkCycleId: cycle?.id ?? null,
  };
}
