import { OperativeDispatch } from "../operative-dispatch/main.ts";
import { launchedRecordIds } from "./planning-record.ts";
import {
  Attempt,
  type AttemptDecision,
  type AttemptFacts,
  REVIEW_ATTEMPT_LIMIT,
  type ReplaceRefusal,
} from "./attempt-machine.ts";
import {
  type AttemptFailure,
  planLaunch,
  readContext,
  type Shared,
  type WorkInspection,
} from "./dispatch-context.ts";
import { record } from "./operations.ts";
import { endAttempt, startAttempt } from "./attempt.ts";
import {
  type DirectionRecord,
  raiseDirection,
  readDirection,
  spendDirection,
  type Unapproved,
} from "./direction.ts";
import { mutate, readState } from "./operations.ts";
import { reopenReview } from "./review.ts";
import { openOperation, recordInspection, recordPlan, settleOperation } from "./dispatch.ts";

export type ReplaceResult =
  | {
      status: "replaced";
      previousAttemptId: string;
      attemptId: string;
      assignmentId: string;
      inspection: WorkInspection;
      repeated: boolean;
    }
  | ReplaceRefusal
  | {
      status: "review-attempt-limit";
      attemptId: string;
      reviewId: string;
      limit: number;
      direction: DirectionRecord;
      approval: Unapproved;
    }
  | AttemptFailure
  | Shared;

type ReplaceRequest = {
  projectRoot: string;
  requestId: string;
  ownerToken: string;
  attemptId: string;
  approvedInspection: string | null;
};

type ReplaceFacts = AttemptFacts["replace"];
type ReplaceNeed = Extract<AttemptDecision["replace"], { need: string }>;

/**
 * Records that one review used every attempt it has, and that the work waits on the user.
 * The request identity is spent here, so a retry reports the same refusal rather than raising
 * the same limit twice.
 */
async function reachedReviewLimit(
  request: ReplaceRequest,
  context: Extract<AttemptDecision["replace"], { limit: unknown }>["limit"],
): Promise<ReplaceResult> {
  const { result } = await mutate<Extract<ReplaceResult, { status: "review-attempt-limit" }>>(
    {
      projectRoot: request.projectRoot,
      requestId: request.requestId,
      ownerToken: request.ownerToken,
      now: new Date().toISOString(),
      operation: "attempt_replace",
      input: { attemptId: request.attemptId, limit: "review_attempts" },
    },
    ({ tx, now }) => ({
      commit: true,
      outcome: {
        status: "review-attempt-limit" as const,
        attemptId: request.attemptId,
        reviewId: context.reviewId,
        limit: REVIEW_ATTEMPT_LIMIT,
        direction: raiseDirection(tx, {
          directionRequestId: crypto.randomUUID(),
          assignmentId: context.producerId,
          limitKind: "review_attempts",
          limitValue: REVIEW_ATTEMPT_LIMIT,
          evidence: {
            used: context.attemptsHeld,
            detail: `Review ${context.reviewId} used ${context.attemptsHeld} attempts without reporting.`,
            attempted: [`review ${context.reviewId}`],
          },
          now,
        }),
        approval: context.approval,
      },
    }),
  );

  return result;
}

/** Reads the one fact the replace decision asked for. */
async function gather(
  request: ReplaceRequest,
  facts: ReplaceFacts,
  need: ReplaceNeed,
): Promise<ReplaceFacts> {
  const { projectRoot } = request;
  switch (need.need) {
    case "direction":
      return {
        ...facts,
        direction: await readState(projectRoot, (db) =>
          readDirection(db, { assignmentId: need.assignmentId, limitKind: "review_attempts" }),
        ),
      };
    case "inspection":
      return {
        ...facts,
        inspection: await OperativeDispatch.inspect({
          projectRoot,
          agentName: need.dispatch.agentName,
          worktreePath: need.dispatch.worktreePath,
          baseCommit: need.dispatch.baseCommit,
        }),
      };
    case "launch":
      return {
        ...facts,
        launch: await planLaunch({
          projectRoot,
          context: facts.context,
          attemptId: facts.attemptId,
          launchAttemptId: facts.launchAttemptId,
          snapshot: need.snapshot,
          baseCommit: need.dispatch.baseCommit,
          branch: need.dispatch.branch,
          worktreePath: need.dispatch.worktreePath,
        }),
      };
  }
}

/**
 * Starts a new attempt on the same assignment, keeping the inspected checkout and branch.
 * It runs only after the former writer is proven stopped and its partial work is inspected,
 * so one assignment never holds two writers.
 * An attempt a replaced Operator claimed is replaceable, because that is how the current owner
 * takes over a stopped writer.
 */
export async function replaceAttempt(request: ReplaceRequest): Promise<ReplaceResult> {
  const read = await readContext(request.projectRoot, { ...request, allowStale: true });
  if (read.status !== "ok") {
    return read;
  }

  // The replacement inspects the stopped writer before it records anything, so whether it may
  // run at all is decided here and the direction it runs under is spent inside that write.
  let facts: ReplaceFacts = {
    context: read.context,
    attemptId: request.attemptId,
    launchAttemptId: crypto.randomUUID(),
    approvedInspection: request.approvedInspection,
  };
  let decision = Attempt.decide("replace", facts);
  while ("need" in decision) {
    facts = await gather(request, facts, decision);
    decision = Attempt.decide("replace", facts);
  }
  if ("refused" in decision) {
    return decision.refused;
  }
  if ("limit" in decision) {
    return reachedReviewLimit(request, decision.limit);
  }

  const replaced = decision;
  const { dispatch, plan } = replaced;
  const previous = read.context.attempt;
  const attemptId = facts.launchAttemptId;
  const written = await record(
    {
      projectRoot: request.projectRoot,
      requestId: request.requestId,
      ownerToken: request.ownerToken,
      operation: "attempt_replace",
      input: { attemptId: request.attemptId, inspection: replaced.inspection.identity },
    },
    ({ tx, now }) => {
      recordInspection(tx, {
        attemptId: previous.id,
        inspection: replaced.inspection,
        identity: replaced.inspection.identity,
        now,
      });
      endAttempt(tx, { attempt: previous, state: replaced.next, now });
      if (replaced.reopen !== null) {
        // The replacement reviewer reads the same fixed submission and reports it itself.
        reopenReview(tx, { review: replaced.reopen, now });
      }
      if (replaced.spend !== null) {
        // The user directed this replacement past the limit, so the request it answered closes.
        spendDirection(tx, { assignmentId: replaced.spend, limitKind: "review_attempts", now });
      }
      startAttempt(tx, {
        attemptId,
        assignmentId: previous.assignmentId,
        ownerToken: request.ownerToken,
        now,
      });
      recordPlan(tx, {
        attemptId,
        assignmentId: previous.assignmentId,
        baseCommit: plan.baseCommit,
        branch: plan.branch,
        worktreePath: plan.worktreePath,
        snapshot: replaced.snapshot,
        snapshotIdentity: plan.snapshotIdentity,
        briefIdentity: plan.briefIdentity,
        promptIdentity: plan.promptIdentity,
        agentName: plan.agentName,
        agentKind: plan.agentKind,
        agentHost: plan.agentHost,
        planningRecordIds: launchedRecordIds(replaced.brief.planningRecords),
        // The inspected checkout is retained, so the replacement never creates a second one.
        workspaceId: dispatch.workspaceId,
        now,
      });

      const retained = crypto.randomUUID();
      openOperation(tx, {
        operationId: retained,
        attemptId,
        kind: "worktree_create",
        requestId: request.requestId,
        intent: { stage: "worktree_create", retained: dispatch.worktreePath },
        now,
      });
      settleOperation(tx, {
        operationId: retained,
        attemptId,
        state: "succeeded",
        detail: `Retained the inspected checkout at ${dispatch.worktreePath}.`,
        now,
      });
      return { commit: true, outcome: { status: "recorded" as const } };
    },
  );
  if (written.status !== "recorded") {
    return written;
  }

  return {
    status: "replaced",
    previousAttemptId: previous.id,
    attemptId,
    assignmentId: previous.assignmentId,
    inspection: replaced.inspection,
    repeated: written.repeated,
  };
}
