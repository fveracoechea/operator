import { and, eq, ne } from "drizzle-orm";
import type { CrewReader, CrewWriter } from "./database.ts";
import type { AssignmentRow } from "./assignment.ts";
import { attemptCount, type AttemptRow } from "./attempt.ts";
import { currentOwnership } from "./ownership.ts";
import { findingsOf, reviewOfAssignment, reviewOfSubmission, type ReviewRow } from "./review.ts";
import { assignments, attemptDispatch, attempts, externalOperations } from "./schema.ts";
import { cyclesOf, openCycleOf, type ReworkCycleRow } from "./rework.ts";
import { type ReworkBriefRecord, storedReworkBrief } from "./rework-input.ts";
import { readSubmission, submissionsOf, type SubmissionRow } from "./submission.ts";

/** The external effects one launch performs, in the order a dispatch performs them. */
export const DISPATCH_STAGES = [
  "worktree_create",
  "input_preparation",
  "agent_start",
  "prompt_delivery",
] as const;

export type DispatchStage = (typeof DISPATCH_STAGES)[number];

/** The external effect that carries one recorded answer to the Operative that asked for it. */
export const ANSWER_DELIVERY = "answer_delivery";

/** The external effects one cleanup performs, each recorded before it acts. */
export const CLEANUP_EFFECTS = ["agent_stop", "worktree_remove"] as const;

export type CleanupEffect = (typeof CLEANUP_EFFECTS)[number];

export type OperationKind = DispatchStage | typeof ANSWER_DELIVERY | CleanupEffect;

export type OperationState = "intended" | "succeeded" | "failed" | "uncertain";

/** A recorded kind this release still knows how to settle. */
export function isDispatchStage(kind: string): kind is DispatchStage {
  return DISPATCH_STAGES.some((stage) => stage === kind);
}

export type DispatchRow = typeof attemptDispatch.$inferSelect;
export type OperationRow = typeof externalOperations.$inferSelect;

/** The fixed result a review attempt reads. Present only on a review assignment. */
export type ReviewContext = {
  review: ReviewRow;
  submission: SubmissionRow;
  // The earlier rounds a reviewer of a revision reads. The launch contract owns their shape.
  priorRounds: ReturnType<typeof priorRoundsOf>;
};

/** The delegated cycle a rework attempt answers. Present only while one is open. */
export type ReworkContext = { cycle: ReworkCycleRow; brief: ReworkBriefRecord };

export type AttemptContext = {
  attempt: AttemptRow;
  assignment: AssignmentRow;
  dispatch: DispatchRow | null;
  operations: OperationRow[];
  review: ReviewContext | null;
  rework: ReworkContext | null;
  // How many attempts this assignment has held, which bounds a replacement.
  attemptsHeld: number;
  // True while the Operator that claimed this attempt still owns the crew.
  current: boolean;
};

export type AttemptLookup =
  | { status: "ok"; context: AttemptContext }
  | { status: "unknown-attempt"; attemptId: string }
  | { status: "attempt-ended"; attemptId: string; state: string }
  | { status: "attempt-not-current"; attemptId: string };

export function readDispatchRow(db: CrewReader, attemptId: string): DispatchRow | null {
  return (
    db.select().from(attemptDispatch).where(eq(attemptDispatch.attemptId, attemptId)).all()[0] ??
    null
  );
}

/** The operations that still describe this attempt. A failed one is history, never a blocker. */
export function liveOperations(db: CrewReader, attemptId: string): OperationRow[] {
  return db
    .select()
    .from(externalOperations)
    .where(and(eq(externalOperations.attemptId, attemptId), ne(externalOperations.state, "failed")))
    .all();
}

/**
 * The operations that recorded an intent and never proved an outcome.
 * An intended or uncertain effect may still have landed, so every reader of that state asks
 * this one question rather than spelling the two states again.
 */
export function unsettledOperations(operations: OperationRow[]): OperationRow[] {
  return operations.filter((one) => one.state === "intended" || one.state === "uncertain");
}

export function readOperation(db: CrewReader, operationId: string): OperationRow | null {
  return (
    db.select().from(externalOperations).where(eq(externalOperations.id, operationId)).all()[0] ??
    null
  );
}

export function operationFor(operations: OperationRow[], kind: DispatchStage): OperationRow | null {
  return operations.find((one) => one.kind === kind) ?? null;
}

/**
 * Every round that ran on one producer assignment before the submission under review.
 * The reviewer of a revision reads them, so a prior disposition is visible and a finding that
 * came back is reported as a regression rather than as new work.
 */
function priorRoundsOf(db: CrewReader, submission: SubmissionRow) {
  const cycles = cyclesOf(db, submission.assignmentId);

  return submissionsOf(db, submission.assignmentId)
    .filter((one) => one.assignmentRevision < submission.assignmentRevision)
    .flatMap((earlier) => {
      const review = reviewOfSubmission(db, earlier.id);
      return review === null
        ? []
        : [
            {
              reviewId: review.id,
              submissionId: earlier.id,
              submissionIdentity: earlier.identity,
              findings: findingsOf(db, review.id).map((one) => ({
                findingId: one.id,
                axis: one.axis,
                key: one.findingKey,
                severity: one.severity,
                summary: one.summary,
                disposition: one.disposition,
                reason: one.reason,
              })),
              cycles: cycles
                .filter((cycle) => cycle.submissionId === earlier.id)
                .map((cycle) => {
                  const brief = storedReworkBrief(cycle.brief);
                  return {
                    cycleId: cycle.id,
                    reason: cycle.reason,
                    cycleIndex: cycle.cycleIndex,
                    instruction: brief.instruction,
                    conflicts: brief.conflicts,
                  };
                }),
            },
          ];
    });
}

/** The review and submission one review assignment carries, if it is one. */
function readReviewContext(db: CrewReader, assignmentId: string): ReviewContext | null {
  const review = reviewOfAssignment(db, assignmentId);
  if (review === null) {
    return null;
  }

  const submission = readSubmission(db, review.submissionId);
  return submission === null
    ? null
    : { review, submission, priorRounds: priorRoundsOf(db, submission) };
}

/** The open rework cycle one assignment carries, with the brief fixed when it was delegated. */
function readReworkContext(db: CrewReader, assignmentId: string): ReworkContext | null {
  const cycle = openCycleOf(db, assignmentId);
  return cycle === null ? null : { cycle, brief: storedReworkBrief(cycle.brief) };
}

/**
 * Reads one attempt with everything a change to it needs, and whether it is still the current
 * writer. An attempt that a replaced Operator claimed stays readable and stays blocked until
 * the new owner adopts it.
 */
export function lookupAttempt(db: CrewReader, attemptId: string): AttemptLookup {
  const attempt = db.select().from(attempts).where(eq(attempts.id, attemptId)).all()[0];
  if (attempt === undefined) {
    return { status: "unknown-attempt", attemptId };
  }
  if (attempt.state !== "active") {
    return { status: "attempt-ended", attemptId: attempt.id, state: attempt.state };
  }

  const assignment = db
    .select()
    .from(assignments)
    .where(eq(assignments.id, attempt.assignmentId))
    .all()[0];
  if (assignment === undefined) {
    return { status: "unknown-attempt", attemptId: attempt.id };
  }

  return {
    status: "ok",
    context: {
      attempt,
      assignment,
      dispatch: readDispatchRow(db, attempt.id),
      operations: liveOperations(db, attempt.id),
      review: readReviewContext(db, assignment.id),
      rework: readReworkContext(db, assignment.id),
      attemptsHeld: attemptCount(db, assignment.id),
      current: currentOwnership(db)?.token === attempt.ownerToken,
    },
  };
}

export function recordPlan(
  db: CrewWriter,
  request: {
    attemptId: string;
    assignmentId: string;
    baseCommit: string;
    branch: string;
    worktreePath: string;
    snapshot: unknown;
    snapshotIdentity: string;
    briefIdentity: string;
    promptIdentity: string;
    agentName: string;
    agentKind: string;
    agentHost: string;
    workspaceId: string | null;
    now: string;
  },
): void {
  db.insert(attemptDispatch)
    .values({
      attemptId: request.attemptId,
      assignmentId: request.assignmentId,
      baseCommit: request.baseCommit,
      branch: request.branch,
      worktreePath: request.worktreePath,
      snapshot: JSON.stringify(request.snapshot),
      snapshotIdentity: request.snapshotIdentity,
      briefIdentity: request.briefIdentity,
      promptIdentity: request.promptIdentity,
      agentName: request.agentName,
      agentKind: request.agentKind,
      agentHost: request.agentHost,
      workspaceId: request.workspaceId,
      paneId: null,
      acknowledgedAt: null,
      inspection: null,
      inspectionIdentity: null,
      createdAt: request.now,
      updatedAt: request.now,
    })
    .run();
}

export function openOperation(
  db: CrewWriter,
  request: {
    operationId: string;
    attemptId: string;
    kind: OperationKind;
    requestId: string;
    intent: unknown;
    now: string;
  },
): void {
  db.insert(externalOperations)
    .values({
      id: request.operationId,
      attemptId: request.attemptId,
      kind: request.kind,
      requestId: request.requestId,
      intent: JSON.stringify(request.intent),
      state: "intended",
      detail: null,
      startedAt: request.now,
      settledAt: null,
    })
    .run();
}

export function settleOperation(
  db: CrewWriter,
  request: {
    operationId: string;
    attemptId: string;
    state: OperationState;
    detail: string | null;
    workspaceId?: string | null;
    paneId?: string | null;
    now: string;
  },
): void {
  db.update(externalOperations)
    .set({ state: request.state, detail: request.detail, settledAt: request.now })
    .where(eq(externalOperations.id, request.operationId))
    .run();

  const runtime = {
    ...(request.workspaceId === undefined ? {} : { workspaceId: request.workspaceId }),
    ...(request.paneId === undefined ? {} : { paneId: request.paneId }),
  };
  if (Object.keys(runtime).length > 0) {
    db.update(attemptDispatch)
      .set({ ...runtime, updatedAt: request.now })
      .where(eq(attemptDispatch.attemptId, request.attemptId))
      .run();
  }
}

export function recordAcknowledgement(
  db: CrewWriter,
  request: { attemptId: string; operations: OperationRow[]; now: string },
): void {
  db.update(attemptDispatch)
    .set({ acknowledgedAt: request.now, updatedAt: request.now })
    .where(eq(attemptDispatch.attemptId, request.attemptId))
    .run();

  // An acknowledgement is the proof of delivery that a timed-out prompt call could not give.
  const delivery = operationFor(request.operations, "prompt_delivery");
  if (delivery !== null && delivery.state !== "succeeded") {
    settleOperation(db, {
      operationId: delivery.id,
      attemptId: request.attemptId,
      state: "succeeded",
      detail: "The Operative acknowledged the assignment.",
      now: request.now,
    });
  }
}

export function recordInspection(
  db: CrewWriter,
  request: { attemptId: string; inspection: unknown; identity: string; now: string },
): void {
  db.update(attemptDispatch)
    .set({
      inspection: JSON.stringify(request.inspection),
      inspectionIdentity: request.identity,
      updatedAt: request.now,
    })
    .where(eq(attemptDispatch.attemptId, request.attemptId))
    .run();
}

/** The stage a dispatch reached, derived from its recorded effects rather than stored twice. */
export function dispatchStage(request: {
  acknowledged: boolean;
  operations: OperationRow[];
}): string {
  if (request.acknowledged) {
    return "acknowledged";
  }

  const reached = DISPATCH_STAGES.filter(
    (stage) => operationFor(request.operations, stage)?.state === "succeeded",
  );
  return reached[reached.length - 1] ?? "planned";
}
