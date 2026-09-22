import { and, eq, ne } from "drizzle-orm";
import { OperativeCleanup } from "../operative-cleanup/main.ts";
import { OperativeDispatch } from "../operative-dispatch/main.ts";
import { type AssignmentRow, readAssignment } from "./assignment.ts";
import { type AttemptRow, readAttempt } from "./attempt.ts";
import {
  CLEANUP_KINDS,
  type CleanupKind,
  type CleanupRow,
  heldRetention,
  readCleanup,
  type RetentionHoldRow,
  workflowRevisionOf,
} from "./cleanup.ts";
import type { CrewReader } from "./database.ts";
import {
  type DispatchRow,
  liveOperations,
  type OperationRow,
  readDispatchRow,
} from "./dispatch.ts";
import { readState, type RequestFailure, type StateFailure } from "./operations.ts";
import { blockingQuestionOf, type QuestionRow } from "./questions.ts";
import { currentOwnership, type Ownership, requireOwnership } from "./ownership.ts";
import { reviewOfAssignment, type ReviewRow } from "./review.ts";
import { attemptDispatch, attempts } from "./schema.ts";
import { storedArtifacts } from "./submission-store.ts";
import { submissionOfAttempt, type SubmissionRow } from "./submission.ts";

export type Shared = StateFailure | RequestFailure;

export type CheckoutInspection = Awaited<ReturnType<typeof OperativeCleanup.inspect>>;

export type CleanupContext = {
  attempt: AttemptRow;
  assignment: AssignmentRow;
  dispatch: DispatchRow;
  ownership: Ownership | null;
  workflowRevision: string;
  submission: SubmissionRow | null;
  review: ReviewRow | null;
  hold: RetentionHoldRow | null;
  /** The question this attempt still waits on. Unfinished work is never cleaned up. */
  openQuestion: QuestionRow | null;
  /** Every cleanup outcome already recorded for this attempt, by kind. */
  cleanups: Map<CleanupKind, CleanupRow>;
  operations: OperationRow[];
  /** Live attempts other than this one whose recorded launch names the same checkout. */
  otherOccupants: string[];
};

export type ContextFailure =
  | { status: "unknown-attempt"; attemptId: string }
  | { status: "not-dispatched"; attemptId: string }
  | Shared;

export type ContextRead = { status: "ok"; context: CleanupContext } | ContextFailure;

/** The attempts that still write in one checkout, which a cleanup must never interrupt. */
function occupantsOfCheckout(
  db: CrewReader,
  request: { attemptId: string; worktreePath: string },
): string[] {
  return db
    .select({ attemptId: attempts.id })
    .from(attempts)
    .innerJoin(attemptDispatch, eq(attemptDispatch.attemptId, attempts.id))
    .where(
      and(
        eq(attemptDispatch.worktreePath, request.worktreePath),
        eq(attempts.state, "active"),
        ne(attempts.id, request.attemptId),
      ),
    )
    .all()
    .map((row) => row.attemptId)
    .toSorted();
}

/**
 * Reads one attempt as a cleanup needs it.
 * A cleanup runs after the writing stopped, so an ended attempt is the ordinary case here and
 * the attempt state is evidence rather than a refusal.
 */
export function readCleanupContext(db: CrewReader, attemptId: string): ContextRead {
  const attempt = readAttempt(db, attemptId);
  if (attempt === null) {
    return { status: "unknown-attempt", attemptId };
  }

  const assignment = readAssignment(db, attempt.assignmentId);
  if (assignment === null) {
    return { status: "unknown-attempt", attemptId };
  }

  const dispatch = readDispatchRow(db, attempt.id);
  if (dispatch === null) {
    return { status: "not-dispatched", attemptId };
  }

  const ownership = currentOwnership(db);
  return {
    status: "ok",
    context: {
      attempt,
      assignment,
      dispatch,
      ownership,
      workflowRevision: workflowRevisionOf(db, ownership?.revision ?? 0),
      submission: submissionOfAttempt(db, attempt.id),
      review: reviewOfAssignment(db, assignment.id),
      hold: heldRetention(db, attempt.id),
      openQuestion: blockingQuestionOf(db, attempt.id),
      cleanups: new Map(
        CLEANUP_KINDS.flatMap((kind) => {
          const row = readCleanup(db, { attemptId: attempt.id, kind });
          return row === null ? [] : [[kind, row] as const];
        }),
      ),
      operations: liveOperations(db, attempt.id),
      otherOccupants: occupantsOfCheckout(db, {
        attemptId: attempt.id,
        worktreePath: dispatch.worktreePath,
      }),
    },
  };
}

/**
 * Reads one cleanup context under the ownership the caller claims.
 * Every external read a cleanup performs happens before its first write, so a replaced
 * Operator is refused here rather than after it has already inspected live resources.
 */
export async function readContext(request: {
  projectRoot: string;
  attemptId: string;
  ownerToken: string | null;
}): Promise<ContextRead> {
  return readState(request.projectRoot, (db) => {
    if (request.ownerToken !== null) {
      const check = requireOwnership(db, request.ownerToken);
      if (check.status === "unowned") {
        return { status: "unowned" as const };
      }
      if (check.status === "stale") {
        return { status: "ownership-stale" as const, ownership: check.ownership };
      }
    }

    return readCleanupContext(db, request.attemptId);
  });
}

/** The evidence one submission already copied into the controlling checkout. */
export function heldArtifacts(
  submission: SubmissionRow | null,
): Array<{ name: string; storedPath: string; contentIdentity: string }> {
  return submission === null
    ? []
    : storedArtifacts(submission.artifacts).flatMap((artifact) =>
        artifact.storedPath === null
          ? []
          : [
              {
                name: `artifact-${artifact.name}`,
                storedPath: artifact.storedPath,
                contentIdentity: artifact.contentIdentity,
              },
            ],
      );
}

/** Reads the checkout this cleanup would touch, excluding everything Operator itself wrote. */
export async function inspectCheckout(context: CleanupContext): Promise<CheckoutInspection> {
  return OperativeCleanup.inspect({
    worktreePath: context.dispatch.worktreePath,
    baseCommit: context.dispatch.baseCommit,
    allowedPrefixes: OperativeDispatch.writtenPrefixes({ agentHost: context.dispatch.agentHost }),
  });
}
