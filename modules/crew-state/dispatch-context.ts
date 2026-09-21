import { OperativeDispatch } from "../operative-dispatch/main.ts";
import { ProjectReadiness } from "../project-readiness/main.ts";
import { isCodeResult, requiredCoverage } from "./submission-input.ts";
import { REVIEW_AXES } from "./review.ts";
import type { AssignmentRow } from "./assignment.ts";
import {
  type AttemptContext,
  type ReviewContext,
  type AttemptLookup,
  DISPATCH_STAGES,
  type DispatchRow,
  type DispatchStage,
  dispatchStage,
  lookupAttempt,
  type OperationRow,
  operationFor,
} from "./dispatch.ts";
import { mutate, readState, type RequestFailure, type StateFailure } from "./operations.ts";
import { requireOwnership } from "./ownership.ts";

export type Overrides = Parameters<typeof ProjectReadiness.snapshot>[0]["overrides"];

export type AttemptFailure = Exclude<AttemptLookup, { status: "ok" }>;

export type Shared = StateFailure | RequestFailure;

// A module states its shapes through its own interface, so these follow the dispatch methods.
type PlanRequest = Parameters<typeof OperativeDispatch.plan>[0];
export type Brief = PlanRequest["brief"];
export type Snapshot = PlanRequest["snapshot"];
export type DispatchPlan = Extract<
  ReturnType<typeof OperativeDispatch.plan>,
  { status: "planned" }
>["plan"];
export type Inspection = Awaited<ReturnType<typeof OperativeDispatch.inspect>>;
export type WorkInspection = Inspection["work"];

export type DispatchReport = {
  attemptId: string;
  assignmentId: string;
  stage: string;
  branch: string;
  baseCommit: string;
  worktreePath: string;
  agentName: string;
  agentHost: string;
  promptIdentity: string;
  snapshotIdentity: string;
  operations: Array<{ kind: string; state: string; detail: string | null }>;
};

export type ContextRead =
  | { status: "ok"; context: AttemptContext }
  | AttemptFailure
  | StateFailure
  | RequestFailure;

type ReviewBrief = NonNullable<Brief["review"]>;

/** The fixed result one review reads, taken from the submission that started it. */
function reviewBriefOf(
  context: ReviewContext,
  request: { attemptId: string; producerTitle: string },
): ReviewBrief {
  const { review, submission } = context;
  return {
    reviewId: review.id,
    attemptId: request.attemptId,
    submissionId: submission.id,
    submissionIdentity: submission.identity,
    resultKind: isCodeResult(submission.resultKind) ? "code" : "non-code",
    axes: [...REVIEW_AXES],
    requiredCoverage: requiredCoverage(submission.resultKind),
    producerAssignmentId: submission.assignmentId,
    producerTitle: request.producerTitle,
    assignmentRevision: submission.assignmentRevision,
    sourceRevision: submission.sourceRevision,
    requirementsIdentity: submission.requirementsIdentity,
    reviewBase: submission.reviewBase,
    code: submission.code === null ? null : JSON.parse(submission.code),
    checks: JSON.parse(submission.checks),
    concerns: JSON.parse(submission.concerns),
    decisions: JSON.parse(submission.decisions),
    artifacts: JSON.parse(submission.artifacts),
  };
}

/** The fixed brief of one assignment, as the attempt that holds it receives it. */
export function briefOf(
  assignment: AssignmentRow,
  attemptId: string,
  review: ReviewContext | null,
): Brief {
  return {
    assignmentId: assignment.id,
    attemptId,
    sourceId: assignment.sourceId,
    sourceKey: assignment.sourceKey,
    sourceRevision: assignment.sourceRevision,
    title: assignment.title,
    kind: assignment.kind,
    acceptanceRequirements: JSON.parse(assignment.acceptanceRequirements),
    approvedScope: assignment.approvedScope,
    permissions: JSON.parse(assignment.permissions),
    fixedInputs: JSON.parse(assignment.fixedInputs),
    review:
      review === null
        ? null
        : reviewBriefOf(review, { attemptId, producerTitle: assignment.title }),
  };
}

export function reportOf(request: {
  attempt: { id: string; assignmentId: string };
  dispatch: DispatchRow;
  operations: OperationRow[];
  acknowledged: boolean;
}): DispatchReport {
  const { dispatch } = request;

  return {
    attemptId: request.attempt.id,
    assignmentId: request.attempt.assignmentId,
    stage: dispatchStage({ acknowledged: request.acknowledged, operations: request.operations }),
    branch: dispatch.branch,
    baseCommit: dispatch.baseCommit,
    worktreePath: dispatch.worktreePath,
    agentName: dispatch.agentName,
    agentHost: dispatch.agentHost,
    promptIdentity: dispatch.promptIdentity,
    snapshotIdentity: dispatch.snapshotIdentity,
    operations: request.operations.map((one) => ({
      kind: one.kind,
      state: one.state,
      detail: one.detail,
    })),
  };
}

export function reportOfContext(context: AttemptContext, dispatch: DispatchRow): DispatchReport {
  return reportOf({
    attempt: context.attempt,
    dispatch,
    operations: context.operations,
    acknowledged: dispatch.acknowledgedAt !== null,
  });
}

/** True when every external effect of one launch is recorded as done. */
export function everyStageSucceeded(operations: OperationRow[]): boolean {
  return DISPATCH_STAGES.every(
    (stage: DispatchStage) => operationFor(operations, stage)?.state === "succeeded",
  );
}

/**
 * Reads one attempt under the ownership the caller claims.
 * A command that finds every stage already finished performs no mutation, so ownership is
 * checked here rather than only inside a write.
 */
export async function readContext(
  projectRoot: string,
  request: { attemptId: string; ownerToken: string | null; allowStale?: boolean },
): Promise<ContextRead> {
  return readState(projectRoot, (db) => {
    if (request.ownerToken !== null) {
      const check = requireOwnership(db, request.ownerToken);
      if (check.status === "unowned") {
        return { status: "unowned" as const };
      }
      if (check.status === "stale") {
        return { status: "ownership-stale" as const, ownership: check.ownership };
      }
    }

    const found = lookupAttempt(db, request.attemptId);
    return found.status === "ok" && !found.context.current && request.allowStale !== true
      ? { status: "attempt-not-current" as const, attemptId: request.attemptId }
      : found;
  });
}

/** A sub-mutation of one dispatch. Only its own success continues the sequence. */
export async function record(
  request: {
    projectRoot: string;
    requestId: string;
    ownerToken: string | null;
    operation: string;
    input: unknown;
  },
  body: Parameters<typeof mutate<{ status: "recorded" }>>[1],
): Promise<{ status: "recorded"; repeated: boolean } | Shared> {
  const { repeated, result } = await mutate<{ status: "recorded" }>(
    { ...request, now: new Date().toISOString() },
    body,
  );
  return result.status === "recorded" ? { status: "recorded", repeated } : result;
}
