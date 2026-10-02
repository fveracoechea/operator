import { OperativeDispatch } from "../operative-dispatch/main.ts";
import { ProjectReadiness } from "../project-readiness/main.ts";
import {
  requiredCoverage,
  storedBehaviorChanges,
  storedChecks,
  storedCode,
  storedConcerns,
  storedDecisions,
  storedResultKind,
} from "./submission-input.ts";
import { ARTIFACT_RULES, specPathOf, storedArtifacts } from "./submission-store.ts";
import { reviewReadCommands, SUBMIT_RULES } from "./submission.ts";
import { REPORT_RULES } from "./review-report.ts";
import { storedFixedInputs, storedPermissions, storedRequirements } from "./work-input.ts";
import { REVIEW_AXES } from "./review.ts";
import {
  type AttemptContext,
  type ReviewContext,
  type ReworkContext,
  type AttemptLookup,
  DISPATCH_STAGES,
  type DispatchRow,
  type DispatchStage,
  dispatchStage,
  lookupAttempt,
  type OperationRow,
  operationFor,
} from "./dispatch.ts";
import { readState, type RequestFailure, type StateFailure } from "./operations.ts";
import { requireOwnership } from "./ownership.ts";
import { identityOf } from "./identity.ts";
import { BEHAVIOR_CHANGE_RULE, ONE_COMMIT_RULE } from "./result-checks.ts";

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
  agentModel: string | null;
  reasoningEffort: string | null;
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
type ReworkBrief = NonNullable<Brief["rework"]>;

/**
 * A writer command reads only an acknowledged attempt, so this line stands beside every command
 * that `readWriterContext` guards.
 */
const ACKNOWLEDGED_RULE = {
  refusal: "attempt_not_acknowledged",
  rule: "Run this only after the acknowledgement above succeeded.",
};

/** The fixed result one review reads, taken from the submission that started it. */
function reviewBriefOf(
  context: ReviewContext,
  request: { attemptId: string; producerTitle: string; fixedInputs: Brief["fixedInputs"] },
): ReviewBrief {
  const { review, submission } = context;
  const resultKind = storedResultKind(submission.resultKind);
  const behaviorChanges = storedBehaviorChanges(submission.behaviorChanges);
  const code = submission.code === null ? null : storedCode(submission.code);
  const specPath = specPathOf(submission.id);
  const spec = request.fixedInputs.find((one) => one.kind === "path" && one.value === specPath);
  return {
    reviewId: review.id,
    attemptId: request.attemptId,
    submissionId: submission.id,
    submissionIdentity: submission.identity,
    resultKind,
    axes: [...REVIEW_AXES],
    requiredCoverage: requiredCoverage(resultKind, behaviorChanges !== null),
    producerAssignmentId: submission.assignmentId,
    producerTitle: request.producerTitle,
    assignmentRevision: submission.assignmentRevision,
    sourceRevision: submission.sourceRevision,
    requirementsIdentity: submission.requirementsIdentity,
    reviewBase: submission.reviewBase,
    code,
    checks: storedChecks(submission.checks),
    concerns: storedConcerns(submission.concerns),
    decisions: storedDecisions(submission.decisions),
    behaviorChanges,
    artifacts: storedArtifacts(submission.artifacts),
    spec:
      spec?.contentIdentity == null
        ? null
        : { storedPath: spec.value, contentIdentity: spec.contentIdentity },
    fixedPoint: code?.baseCommit ?? null,
    readCommands: reviewReadCommands(code?.baseCommit ?? null),
    priorRounds: context.priorRounds,
  };
}

/** The fixed cycle one rework attempt answers, as it was recorded when it was delegated. */
function reworkBriefOf(context: ReworkContext): ReworkBrief {
  // The recorded instruction is Operator text, and the Operator writes nothing into a brief.
  const { instruction: _instruction, ...recorded } = context.brief;
  return { cycleId: context.cycle.id, ...recorded };
}

/** The fixed brief of one assignment, as the attempt that holds it receives it. */
export function briefOf(context: AttemptContext, attemptId: string): Brief {
  const assignment = context.assignment;
  const review = context.review;
  const acceptanceRequirements = storedRequirements(assignment.acceptanceRequirements);
  const fixedInputs = storedFixedInputs(assignment.fixedInputs);
  return {
    assignmentId: assignment.id,
    assignmentRevision: assignment.revision,
    attemptId,
    sourceId: assignment.sourceId,
    sourceKey: assignment.sourceKey,
    sourceRevision: assignment.sourceRevision,
    title: assignment.title,
    kind: assignment.kind,
    acceptanceRequirements,
    requirementsIdentity: identityOf(acceptanceRequirements),
    approvedScope: assignment.approvedScope,
    permissions: { ...storedPermissions(assignment.permissions), writePaths: context.writePaths },
    fixedInputs,
    // A reviewer reports and never submits, so it receives none of the producer's rules.
    rules:
      review === null
        ? {
            submit: [
              ACKNOWLEDGED_RULE,
              ONE_COMMIT_RULE,
              ...ARTIFACT_RULES,
              ...SUBMIT_RULES,
              BEHAVIOR_CHANGE_RULE,
            ],
            report: [],
          }
        : { submit: [], report: [ACKNOWLEDGED_RULE, ...REPORT_RULES] },
    review:
      review === null
        ? null
        : reviewBriefOf(review, { attemptId, producerTitle: assignment.title, fixedInputs }),
    rework: context.rework === null ? null : reworkBriefOf(context.rework),
  };
}

export function reportOf(request: {
  attempt: { id: string; assignmentId: string };
  dispatch: DispatchRow;
  operations: OperationRow[];
  acknowledged: boolean;
}): DispatchReport {
  const { dispatch } = request;
  const recorded = OperativeDispatch.readSnapshot({ recorded: dispatch.snapshot });
  const crew = recorded.status === "read" ? recorded.snapshot.selection.crew : null;

  return {
    attemptId: request.attempt.id,
    assignmentId: request.attempt.assignmentId,
    stage: dispatchStage({ acknowledged: request.acknowledged, operations: request.operations }),
    branch: dispatch.branch,
    baseCommit: dispatch.baseCommit,
    worktreePath: dispatch.worktreePath,
    agentName: dispatch.agentName,
    agentHost: dispatch.agentHost,
    agentModel: crew?.model ?? null,
    reasoningEffort: crew?.reasoningEffort ?? null,
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

export type WriterFailure =
  | { status: "not-dispatched"; attemptId: string }
  | { status: "not-acknowledged"; attemptId: string }
  | { status: "reference-mismatch"; attemptId: string; detail: string }
  | AttemptFailure
  | Shared;

export type WriterRead =
  | { status: "ok"; context: AttemptContext; dispatch: DispatchRow }
  | WriterFailure;

/**
 * Reads one attempt as the Operative or reviewer that runs in its worktree.
 * Both carry no ownership token, so the attempt must still be the current writer, must have
 * been launched, must run in the checkout it names, and must have acknowledged its brief.
 */
export async function readWriterContext(
  projectRoot: string,
  request: { attemptId: string; worktreePath: string },
): Promise<WriterRead> {
  const read = await readContext(projectRoot, {
    attemptId: request.attemptId,
    ownerToken: null,
  });
  if (read.status !== "ok") {
    return read;
  }

  const dispatch = read.context.dispatch;
  if (dispatch === null) {
    return { status: "not-dispatched", attemptId: request.attemptId };
  }
  if (dispatch.worktreePath !== request.worktreePath) {
    return {
      status: "reference-mismatch",
      attemptId: request.attemptId,
      detail: `This attempt is recorded against ${dispatch.worktreePath}.`,
    };
  }
  // An unacknowledged attempt never proved the brief arrived, so it reports nothing fixed.
  if (dispatch.acknowledgedAt === null) {
    return { status: "not-acknowledged", attemptId: request.attemptId };
  }

  return { status: "ok", context: read.context, dispatch };
}
