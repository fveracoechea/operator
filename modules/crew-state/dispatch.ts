import { and, asc, eq, ne } from "drizzle-orm";
import { z } from "zod";
import type { CrewReader, CrewWriter } from "./database.ts";
import type { AssignmentRow } from "./assignment.ts";
import { attemptCount, type AttemptRow } from "./attempt.ts";
import { currentOwnership } from "./ownership.ts";
import { findingsOf, reviewOfAssignment, reviewOfSubmission, type ReviewRow } from "./review.ts";
import {
  type BranchSnapshotRow,
  publishesAlone,
  readSnapshot,
  type SnapshotCommit,
  storedSnapshotCommits,
} from "./branch-review.ts";
import { storedTargets } from "./review-input.ts";
import { readAssignment } from "./assignment.ts";
import {
  assignments,
  attemptDispatch,
  attempts,
  externalOperations,
  questions,
  reviews as reviewsTable,
} from "./schema.ts";
import { answerRecordOf, questionReportOf, type QuestionRow, readAnswer } from "./questions.ts";
import { storedBehaviorChanges, storedConcerns, storedDecisions } from "./submission-input.ts";
import { cyclesOf, openCycleOf, type ReworkCycleRow } from "./rework.ts";
import { type ReworkBriefRecord, storedReworkBrief } from "./rework-input.ts";
import { readSubmission, submissionsOf, type SubmissionRow } from "./submission.ts";
import { effectiveWritePaths } from "./write-path-grants.ts";
import { type BriefRecord, briefRecords } from "./planning-record.ts";
import { readStored } from "./stored.ts";

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
  // Each question that a behavior change names as its basis, with the answer it held at submit.
  basisQuestions: ReturnType<typeof basisQuestionsOf>;
  // The earlier rounds a reviewer of a revision reads. The launch contract owns their shape.
  priorRounds: ReturnType<typeof priorRoundsOf>;
  // True when this review writes the published text, because no branch review follows it.
  publishes: boolean;
};

/** The branch snapshot a branch review attempt reads. Present only on a branch review. */
export type BranchReviewContext = {
  review: ReviewRow;
  snapshot: BranchSnapshotRow;
  commits: SnapshotCommit[];
  // Every earlier review of the source, which the branch reviewer reads as context.
  earlierReviews: ReturnType<typeof earlierReviewsOf>;
};

/** The delegated cycle a rework attempt answers. Present only while one is open. */
export type ReworkContext = {
  cycle: ReworkCycleRow;
  brief: ReworkBriefRecord;
  // The recorded rounds of the assignment, derived at dispatch. The launch contract owns them.
  rounds: ReturnType<typeof reworkRoundsOf>;
};

export type AttemptContext = {
  attempt: AttemptRow;
  assignment: AssignmentRow;
  dispatch: DispatchRow | null;
  operations: OperationRow[];
  review: ReviewContext | null;
  branchReview: BranchReviewContext | null;
  rework: ReworkContext | null;
  // The planning records this attempt's launch carried, or null when its launch fixed none, and
  // the latest records, which a new launch carries. A review reads the producer's records.
  planning: { launched: BriefRecord[] | null; latest: BriefRecord[] };
  // The registered write paths plus every current grant, which the brief and submit read.
  writePaths: string[];
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

/** The rework cycle that delegated each finding as a correction, by finding id. */
function delegationsOf(cycles: ReworkCycleRow[]): Map<string, string> {
  return new Map(
    cycles.flatMap((cycle) =>
      storedReworkBrief(cycle.brief).corrections.map((one) => [one.findingId, cycle.id] as const),
    ),
  );
}

/**
 * Every reviewed round of one assignment whose submission passes the filter, with each finding,
 * its disposition, and the cycle that delegated it. A reviewer of a revision reads the rounds
 * before it, and a rework Operative reads every round up to the submission it corrects.
 */
function roundsOf(
  db: CrewReader,
  request: { assignmentId: string; includes: (submission: SubmissionRow) => boolean },
) {
  const cycles = cyclesOf(db, request.assignmentId);
  const delegations = delegationsOf(cycles);

  return submissionsOf(db, request.assignmentId)
    .filter(request.includes)
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
                delegatedIn: delegations.get(one.id) ?? null,
              })),
              cycles: cycles
                .filter((cycle) => cycle.submissionId === earlier.id)
                .map((cycle) => {
                  const brief = storedReworkBrief(cycle.brief);
                  return {
                    cycleId: cycle.id,
                    reason: cycle.reason,
                    cycleIndex: cycle.cycleIndex,
                    conflicts: brief.conflicts,
                  };
                }),
            },
          ];
    });
}

/**
 * Every round that ran on one producer assignment before the submission under review.
 * The reviewer of a revision reads them, so a prior disposition is visible and a finding that
 * came back is reported as a regression rather than as new work.
 */
function priorRoundsOf(db: CrewReader, submission: SubmissionRow) {
  return roundsOf(db, {
    assignmentId: submission.assignmentId,
    includes: (one) => one.assignmentRevision < submission.assignmentRevision,
  });
}

/** The review and submission one review assignment carries, if it is one. */
function readReviewContext(db: CrewReader, assignmentId: string): ReviewContext | null {
  const review = reviewOfAssignment(db, assignmentId);
  if (review === null) {
    return null;
  }

  const submission = review.submissionId === null ? null : readSubmission(db, review.submissionId);
  return submission === null
    ? null
    : {
        review,
        submission,
        basisQuestions: basisQuestionsOf(db, submission),
        priorRounds: priorRoundsOf(db, submission),
        publishes: publishesAlone(db, submission),
      };
}

/**
 * Every review of one source that reported before this one, with each finding and its answer.
 * A branch reviewer reads them, so a disposition is visible and a returned defect is reported as
 * a regression. Their records are fixed once written, so a recovery reads the same list.
 */
function earlierReviewsOf(db: CrewReader, review: ReviewRow, sourceId: string) {
  const held = new Map(
    db
      .select()
      .from(assignments)
      .where(eq(assignments.sourceId, sourceId))
      .all()
      .map((row) => [row.id, row]),
  );
  return db
    .select()
    .from(reviewsTable)
    .all()
    .filter(
      (one) =>
        one.id !== review.id &&
        held.has(one.assignmentId) &&
        one.state === "reported" &&
        one.createdAt <= review.createdAt,
    )
    .toSorted(
      (left, right) =>
        left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id),
    )
    .map((one) => {
      const snapshot = one.snapshotId === null ? null : readSnapshot(db, one.snapshotId);
      const submission = one.submissionId === null ? null : readSubmission(db, one.submissionId);
      const producer = submission === null ? null : readAssignment(db, submission.assignmentId);
      return {
        reviewId: one.id,
        kind: snapshot === null ? ("result" as const) : ("branch" as const),
        subject:
          snapshot === null
            ? `submission ${one.submissionId ?? "unknown"} of ${producer?.sourceKey ?? "unknown"}`
            : `snapshot ${snapshot.id} at head ${snapshot.headCommit}`,
        findings: findingsOf(db, one.id).map((finding) => ({
          findingId: finding.id,
          axis: finding.axis,
          key: finding.findingKey,
          severity: finding.severity,
          summary: finding.summary,
          disposition: finding.disposition,
          reason: finding.reason,
          targets: finding.targets === null ? null : storedTargets(finding.targets),
        })),
      };
    });
}

/** The branch snapshot one branch review assignment reads, if it is one. */
function readBranchReviewContext(
  db: CrewReader,
  assignment: AssignmentRow,
): BranchReviewContext | null {
  const review = reviewOfAssignment(db, assignment.id);
  const snapshot = review?.snapshotId == null ? null : readSnapshot(db, review.snapshotId);
  return review === null || snapshot === null
    ? null
    : {
        review,
        snapshot,
        commits: storedSnapshotCommits(snapshot.commits),
        earlierReviews: earlierReviewsOf(db, review, assignment.sourceId),
      };
}

/**
 * Every question of the assignment that was raised and answered before the cycle was delegated.
 * An attempt of the cycle asks nothing that reaches this list, so a replacement attempt of the
 * cycle receives the same answers as the attempt it replaces.
 */
function answeredQuestionsOf(db: CrewReader, cycle: ReworkCycleRow) {
  return db
    .select()
    .from(questions)
    .where(eq(questions.assignmentId, cycle.assignmentId))
    .orderBy(asc(questions.raisedAt), asc(questions.id))
    .all()
    .filter((row) => row.raisedAt < cycle.openedAt)
    .flatMap((row) => answeredBy(db, row, cycle.openedAt));
}

/** One question with the answer it held at a moment, or nothing when it held none then. */
function answeredBy(db: CrewReader, row: QuestionRow, moment: string) {
  const answer = row.answerId === null ? null : readAnswer(db, row.answerId);
  if (answer === null || answer.recordedAt > moment) {
    return [];
  }
  const record = answerRecordOf(answer, row);
  return [
    {
      questionId: row.id,
      attemptId: row.attemptId,
      question: questionReportOf(row).question,
      authority: record.authority,
      exactText: record.exactText,
      interpretation: record.interpretation,
    },
  ];
}

/**
 * Each question of the producer assignment that a behavior change of the submission names as its
 * basis, in list order, with the answer it held at submit. The reviewer checks that the answer
 * permits the change, so the brief gives the question, the authority, and the answer beside it.
 */
function basisQuestionsOf(db: CrewReader, submission: SubmissionRow) {
  const named = (storedBehaviorChanges(submission.behaviorChanges) ?? []).flatMap((one) =>
    one.basis.kind === "question" ? [one.basis.questionId] : [],
  );
  return [...new Set(named)].flatMap((questionId) => {
    const row = db.select().from(questions).where(eq(questions.id, questionId)).all()[0];
    return row === undefined || row.assignmentId !== submission.assignmentId
      ? []
      : answeredBy(db, row, submission.submittedAt);
  });
}

/**
 * The recorded rounds one rework brief carries, derived at dispatch (ADR 0008).
 * Each record is fixed once it is written, so this gives the same text as a derivation at the
 * moment the cycle was delegated.
 */
function reworkRoundsOf(db: CrewReader, cycle: ReworkCycleRow) {
  const corrected = readSubmission(db, cycle.submissionId);
  if (corrected === null) {
    throw new Error(`rework cycle ${cycle.id} names no recorded submission`);
  }

  return {
    concerns: storedConcerns(corrected.concerns),
    decisions: storedDecisions(corrected.decisions),
    behaviorChanges: storedBehaviorChanges(corrected.behaviorChanges),
    answeredQuestions: answeredQuestionsOf(db, cycle),
    earlier: roundsOf(db, {
      assignmentId: cycle.assignmentId,
      includes: (one) => one.assignmentRevision <= corrected.assignmentRevision,
    }),
  };
}

/** The open rework cycle one assignment carries, with the brief fixed when it was delegated. */
function readReworkContext(db: CrewReader, assignmentId: string): ReworkContext | null {
  const cycle = openCycleOf(db, assignmentId);
  return cycle === null
    ? null
    : { cycle, brief: storedReworkBrief(cycle.brief), rounds: reworkRoundsOf(db, cycle) };
}

/** The planning record ids one launch fixed, or null when it fixed none. */
function launchedRecordIdsOf(row: DispatchRow | null): string[] | null {
  return row?.planningRecordIds == null
    ? null
    : readStored("planning record id list", z.array(z.string()), row.planningRecordIds);
}

/**
 * The planning records a brief of this attempt carries.
 * A review reads the records of the producer brief, which the producer launch fixed, so the
 * Spec axis checks the result against the decisions that it followed.
 */
function planningOf(
  db: CrewReader,
  request: { assignmentId: string; dispatch: DispatchRow | null; review: ReviewContext | null },
): AttemptContext["planning"] {
  if (request.review !== null) {
    const { submission } = request.review;
    const records = briefRecords(db, {
      assignmentId: submission.assignmentId,
      launched: launchedRecordIdsOf(readDispatchRow(db, submission.attemptId)),
    });
    return { launched: records, latest: records };
  }

  const launched = launchedRecordIdsOf(request.dispatch);
  return {
    launched:
      launched === null ? null : briefRecords(db, { assignmentId: request.assignmentId, launched }),
    latest: briefRecords(db, { assignmentId: request.assignmentId, launched: null }),
  };
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

  const dispatch = readDispatchRow(db, attempt.id);
  const review = readReviewContext(db, assignment.id);
  return {
    status: "ok",
    context: {
      attempt,
      assignment,
      dispatch,
      operations: liveOperations(db, attempt.id),
      review,
      branchReview: readBranchReviewContext(db, assignment),
      rework: readReworkContext(db, assignment.id),
      planning: planningOf(db, { assignmentId: assignment.id, dispatch, review }),
      writePaths: effectiveWritePaths(db, assignment),
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
    planningRecordIds: string[];
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
      outsideScan: null,
      planningRecordIds: JSON.stringify(request.planningRecordIds),
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

  const runtime: { workspaceId?: string | null; paneId?: string | null } = {};
  if (request.workspaceId !== undefined) runtime.workspaceId = request.workspaceId;
  if (request.paneId !== undefined) runtime.paneId = request.paneId;
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

/** Records the "before" scan of one production attempt (ADR 0018). Submit compares it again. */
export function recordOutsideScan(
  db: CrewWriter,
  request: { attemptId: string; scan: unknown; now: string },
): void {
  db.update(attemptDispatch)
    .set({ outsideScan: JSON.stringify(request.scan), updatedAt: request.now })
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
