import { OperativeCleanup } from "../operative-cleanup/main.ts";
import { type ApprovalCheck } from "./approval-input.ts";
import { type ApprovalRecord, matchApproval } from "./approvals.ts";
import {
  CLEANUP_OPERATION,
  type CleanupState,
  cleanupRecordOf,
  cleanupRevisionOf,
  recordCleanup,
} from "./cleanup.ts";
import { type ContextFailure, inspectCheckout, readContext, record } from "./cleanup-context.ts";
import { checkoutBlockers, holdBlocker, identityBlocker } from "./cleanup-gates.ts";
import { matchIdentity } from "./cleanup-identity.ts";
import { type CleanupBlocker, type CleanupReport, reportOf } from "./cleanup-report.ts";
import { openOperation, settleOperation } from "./dispatch.ts";
import { readState } from "./operations.ts";

/** The one action a person approves before any Operative checkout is removed. */
export const WORKTREE_DELETE = "worktree_delete";

export type RemoveResult =
  | { status: "removed"; report: CleanupReport; repeated: boolean }
  | { status: "already-removed"; report: CleanupReport }
  | { status: "blocked"; report: CleanupReport; blockers: CleanupBlocker[] }
  | { status: "uncertain"; report: CleanupReport; detail: string }
  | { status: "failed"; report: CleanupReport; detail: string }
  | ContextFailure;

const KIND = "worktree_removal";

/**
 * The two approvals that permit one removal.
 * A per-cleanup grant names this checkout at the revision it was inspected at. A workflow grant
 * names the repository at the revision of the registered work and the Operator that owns it.
 */
function approvalChecks(request: {
  projectRoot: string;
  worktreePath: string;
  workflowRevision: string;
  cleanupRevision: string;
}): ApprovalCheck[] {
  return [
    {
      action: WORKTREE_DELETE,
      targets: [request.worktreePath],
      scope: "cleanup",
      requestRevision: request.cleanupRevision,
    },
    {
      action: WORKTREE_DELETE,
      targets: [request.projectRoot],
      scope: "workflow",
      requestRevision: request.workflowRevision,
    },
  ];
}

type ApprovalOutcome =
  | { status: "covered"; approval: ApprovalRecord }
  | { status: "revoked"; approval: ApprovalRecord }
  | { status: "missing"; checks: ApprovalCheck[] };

async function readApproval(
  projectRoot: string,
  checks: ApprovalCheck[],
): Promise<ApprovalOutcome | { status: "unreadable" }> {
  const matches = await readState(projectRoot, (db) =>
    checks.map((check) => matchApproval(db, check)),
  );
  if (!Array.isArray(matches)) {
    return { status: "unreadable" };
  }

  const covered = matches.find((one) => one.status === "matched");
  if (covered !== undefined && covered.status === "matched") {
    return { status: "covered", approval: covered.approval };
  }

  // A grant that was revoked covers nothing, and saying so names what the user already decided.
  const revoked = matches.find((one) => one.status === "revoked");
  return revoked !== undefined && revoked.status === "revoked"
    ? { status: "revoked", approval: revoked.approval }
    : { status: "missing", checks };
}

/**
 * Removes one approved Operative checkout through Herdr.
 * Acceptance is not disposal authority, so the removal runs only behind a closed process, an
 * accepted result, preserved evidence, remote copies of every commit, and an approval granted
 * against these exact inputs.
 */
export async function removeWorktree(request: {
  projectRoot: string;
  requestId: string;
  ownerToken: string;
  attemptId: string;
}): Promise<RemoveResult> {
  const read = await readContext({
    projectRoot: request.projectRoot,
    attemptId: request.attemptId,
    ownerToken: request.ownerToken,
  });
  if (read.status !== "ok") {
    return read;
  }

  const context = read.context;
  const held = context.removal;
  const inspection = await inspectCheckout(context);
  const requestRevision = cleanupRevisionOf({
    workflowRevision: context.workflowRevision,
    kind: KIND,
    attemptId: context.attempt.id,
    assignmentId: context.assignment.id,
    worktreePath: context.dispatch.worktreePath,
    branch: context.dispatch.branch,
    inspectionIdentity: inspection.identity,
  });

  function report(state: string, row = held): CleanupReport {
    return reportOf({ context, kind: KIND, state, requestRevision, row });
  }

  if (held !== null && held.state === "done") {
    return { status: "already-removed", report: report("done") };
  }

  async function settle(settlement: {
    state: CleanupState;
    detail: string;
    operation: { id: string; state: "succeeded" | "failed" | "uncertain" } | null;
  }) {
    return record(
      {
        projectRoot: request.projectRoot,
        requestId: `${request.requestId}#${KIND}.${settlement.state}`,
        ownerToken: request.ownerToken,
        operation: "cleanup_remove_record",
        input: {
          attemptId: context.attempt.id,
          state: settlement.state,
          detail: settlement.detail,
          requestRevision,
        },
      },
      ({ tx, now }) => {
        if (settlement.operation !== null) {
          settleOperation(tx, {
            operationId: settlement.operation.id,
            attemptId: context.attempt.id,
            state: settlement.operation.state,
            detail: settlement.detail,
            now,
          });
        }

        recordCleanup(tx, {
          cleanupId: crypto.randomUUID(),
          attemptId: context.attempt.id,
          assignmentId: context.assignment.id,
          kind: KIND,
          state: settlement.state,
          requestRevision,
          inspection,
          evidence: null,
          detail: settlement.detail,
          now,
        });
        return { commit: true, outcome: { status: "recorded" as const } };
      },
    );
  }

  async function refuse(blockers: CleanupBlocker[]): Promise<RemoveResult> {
    const written = await settle({
      state: "blocked",
      detail: blockers.map((one) => one.reason).join(", "),
      operation: null,
    });
    return written.status === "recorded"
      ? { status: "blocked", report: report("blocked"), blockers }
      : written;
  }

  const gates: CleanupBlocker[] = [
    ...(holdBlocker(context) === null ? [] : [holdBlocker(context)]),
    ...(context.closure === null || context.closure.state !== "done"
      ? [{ reason: "process_live" as const, state: context.closure?.state ?? "none" }]
      : []),
    ...(context.assignment.state === "accepted"
      ? []
      : [
          {
            reason: "not_accepted" as const,
            assignmentId: context.assignment.id,
            state: context.assignment.state,
          },
        ]),
    ...checkoutBlockers(inspection, { requireRemote: true }),
  ].flatMap((one) => (one === null ? [] : [one]));
  if (gates.length > 0) {
    return refuse(gates);
  }

  const identity = await matchIdentity({ projectRoot: request.projectRoot, context });
  const started = context.operations.find((one) => one.kind === CLEANUP_OPERATION[KIND]) ?? null;

  // A removal that already landed but never answered is settled from what Herdr shows now.
  if (identity.status === "matched" && !identity.checkoutPresent) {
    if (started === null) {
      return refuse([
        {
          reason: "unrelated_resource",
          worktreePath: context.dispatch.worktreePath,
          detail: "Herdr holds no worktree at that path, and Operator removes nothing else.",
        },
      ]);
    }

    const detail = `Herdr no longer holds ${context.dispatch.worktreePath}.`;
    const reconciled = await settle({
      state: "done",
      detail,
      operation: { id: started.id, state: "succeeded" },
    });
    return reconciled.status === "recorded"
      ? { status: "removed", report: report("done"), repeated: reconciled.repeated }
      : reconciled;
  }

  if (identity.status !== "matched") {
    return refuse([identityBlocker(identity)]);
  }

  // The evidence the closure preserved must still be readable, because deletion is the last
  // moment at which the record could be repaired from the worktree.
  const preserved = context.closure === null ? [] : cleanupRecordOf(context.closure).evidence;
  const verified = await OperativeCleanup.verify({
    projectRoot: request.projectRoot,
    items: preserved,
  });
  if (verified.status !== "verified") {
    return refuse([{ reason: "preservation_failed", name: verified.name, path: verified.path }]);
  }

  const checks = approvalChecks({
    projectRoot: request.projectRoot,
    worktreePath: context.dispatch.worktreePath,
    workflowRevision: context.workflowRevision,
    cleanupRevision: requestRevision,
  });
  const approval = await readApproval(request.projectRoot, checks);
  if (approval.status === "unreadable") {
    return refuse([
      { reason: "checkout_unknown", detail: "The crew state could not be read for approvals." },
    ]);
  }
  if (approval.status === "revoked") {
    return refuse([{ reason: "approval_revoked", approvalId: approval.approval.approvalId }]);
  }
  if (approval.status === "missing") {
    return refuse(
      approval.checks.map((check) => ({
        reason: "approval_required" as const,
        action: check.action,
        targets: check.targets,
        scope: check.scope,
        requestRevision: check.requestRevision,
      })),
    );
  }

  const operationId = started?.id ?? crypto.randomUUID();
  if (started === null) {
    const opened = await record(
      {
        projectRoot: request.projectRoot,
        requestId: `${request.requestId}#${KIND}.open`,
        ownerToken: request.ownerToken,
        operation: "cleanup_remove_intent",
        input: { attemptId: context.attempt.id, operationId },
      },
      ({ tx, now }) => {
        openOperation(tx, {
          operationId,
          attemptId: context.attempt.id,
          kind: CLEANUP_OPERATION[KIND],
          requestId: request.requestId,
          intent: {
            kind: KIND,
            workspaceId: identity.workspaceId,
            worktreePath: context.dispatch.worktreePath,
            approvalId: approval.approval.approvalId,
          },
          now,
        });
        recordCleanup(tx, {
          cleanupId: crypto.randomUUID(),
          attemptId: context.attempt.id,
          assignmentId: context.assignment.id,
          kind: KIND,
          state: "pending",
          requestRevision,
          inspection,
          evidence: null,
          detail: `Approved removal of ${context.dispatch.worktreePath} was requested.`,
          now,
        });
        return { commit: true, outcome: { status: "recorded" as const } };
      },
    );
    if (opened.status !== "recorded") {
      return opened;
    }
  }

  const removed = await OperativeCleanup.remove({
    repoRoot: request.projectRoot,
    workspaceId: identity.workspaceId,
    worktreePath: context.dispatch.worktreePath,
  });

  if (removed.status === "uncertain") {
    const written = await settle({
      state: "uncertain",
      detail: removed.detail,
      operation: { id: operationId, state: "uncertain" },
    });
    return written.status === "recorded"
      ? { status: "uncertain", report: report("uncertain"), detail: removed.detail }
      : written;
  }

  if (removed.status !== "removed") {
    const detail =
      removed.status === "failed" ? `${removed.code}: ${removed.detail}` : removed.detail;
    const written = await settle({
      state: "failed",
      detail,
      operation: { id: operationId, state: "failed" },
    });
    return written.status === "recorded"
      ? { status: "failed", report: report("failed"), detail }
      : written;
  }

  const detail = `Herdr removed ${context.dispatch.worktreePath}.`;
  const written = await settle({
    state: "done",
    detail,
    operation: { id: operationId, state: "succeeded" },
  });
  if (written.status !== "recorded") {
    return written;
  }

  const final = await readContext({
    projectRoot: request.projectRoot,
    attemptId: request.attemptId,
    ownerToken: null,
  });
  return {
    status: "removed",
    report: report("done", final.status === "ok" ? final.context.removal : held),
    repeated: written.repeated,
  };
}
