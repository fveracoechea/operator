import { OperativeCleanup } from "../operative-cleanup/main.ts";
import { storedAssignmentState } from "./assignment.ts";
import type { ApprovalCheck } from "./approval-input.ts";
import { type ApprovalRecord, matchApproval } from "./approvals.ts";
import { cleanupRecordOf, cleanupRevisionOf } from "./cleanup.ts";
import { type ContextFailure, inspectCheckout, readContext } from "./cleanup-context.ts";
import { checkoutBlockers, holdBlocker, hostBlocker, identityBlocker } from "./cleanup-gates.ts";
import { matchIdentity } from "./cleanup-identity.ts";
import type { CleanupBlocker, CleanupReport } from "./cleanup-report.ts";
import { cleanupWriter } from "./cleanup-write.ts";
import { readState, type StateFailure } from "./operations.ts";

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
 * The approvals that permit one removal. Either one is enough.
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

/**
 * Finds the approval that covers this removal, if this crew holds one.
 * A state file that cannot answer is reported as the state failure it is, because the resource
 * a person would then have to settle is the crew state and not the checkout.
 */
async function readApproval(
  projectRoot: string,
  checks: ApprovalCheck[],
): Promise<{ outcome: ApprovalOutcome } | { failure: StateFailure }> {
  const matches = await readState(projectRoot, (db) =>
    checks.map((check) => matchApproval(db, check)),
  );
  if (!Array.isArray(matches)) {
    return { failure: matches };
  }

  const covered = matches.find((one) => one.status === "matched");
  if (covered !== undefined && covered.status === "matched") {
    return { outcome: { status: "covered", approval: covered.approval } };
  }

  // A grant that was revoked covers nothing, and saying so names what the user already decided.
  const revoked = matches.find((one) => one.status === "revoked");
  return {
    outcome:
      revoked !== undefined && revoked.status === "revoked"
        ? { status: "revoked", approval: revoked.approval }
        : { status: "missing", checks },
  };
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
  const held = context.cleanups.get(KIND) ?? null;
  const closure = context.cleanups.get("process_closure") ?? null;
  if (held !== null && held.state === "done") {
    return {
      status: "already-removed",
      report: cleanupWriter({
        ...request,
        context,
        kind: KIND,
        requestRevision: held.requestRevision,
        inspection: null,
      }).report("done"),
    };
  }

  const unknownHost = hostBlocker(context);
  const inspection = await inspectCheckout(context);
  const writer = cleanupWriter({
    ...request,
    context,
    kind: KIND,
    requestRevision: cleanupRevisionOf({
      workflowRevision: context.workflowRevision,
      kind: KIND,
      attemptId: context.attempt.id,
      assignmentId: context.assignment.id,
      worktreePath: context.dispatch.worktreePath,
      branch: context.dispatch.branch,
      inspectionIdentity: inspection.identity,
    }),
    inspection,
  });

  async function refuse(blockers: CleanupBlocker[]): Promise<RemoveResult> {
    const written = await writer.refuse(blockers);
    return written.status === "recorded"
      ? { status: "blocked", report: writer.report("blocked"), blockers }
      : written;
  }

  if (unknownHost !== null) {
    return refuse([unknownHost]);
  }

  const gates: CleanupBlocker[] = [
    holdBlocker(context),
    ...(closure === null || closure.state !== "done"
      ? [{ reason: "process_live" as const, state: closure?.state ?? "none" }]
      : []),
    ...(storedAssignmentState(context.assignment.state) === "accepted"
      ? []
      : [
          {
            reason: "assignment_not_accepted" as const,
            assignmentId: context.assignment.id,
            state: storedAssignmentState(context.assignment.state),
          },
        ]),
    ...checkoutBlockers(inspection, { requireRemote: true }),
  ].flatMap((one) => (one === null ? [] : [one]));
  if (gates.length > 0) {
    return refuse(gates);
  }

  // A removal that already landed but never answered is settled from what Herdr shows now,
  // ahead of every identity read, because the checkout it would read from is already gone.
  const started = writer.openedOperation();
  if (started !== null) {
    const checkout = await OperativeCleanup.findCheckout({
      repoRoot: request.projectRoot,
      path: context.dispatch.worktreePath,
    });
    if (checkout.status === "unknown") {
      return refuse([{ reason: "checkout_unknown", detail: checkout.detail }]);
    }
    if (checkout.status === "absent") {
      const reconciled = await writer.settle({
        state: "done",
        detail: `Herdr no longer holds ${context.dispatch.worktreePath}.`,
        operation: { id: started.id, state: "succeeded" },
      });
      return reconciled.status === "recorded"
        ? { status: "removed", report: writer.report("done"), repeated: reconciled.repeated }
        : reconciled;
    }
  }

  const identity = await matchIdentity({ projectRoot: request.projectRoot, context });
  if (identity.status !== "matched") {
    return refuse([identityBlocker(identity)]);
  }

  // The evidence the closure preserved must still be readable, because deletion is the last
  // moment at which the record could be repaired from the worktree.
  const preserved = closure === null ? [] : cleanupRecordOf(closure).evidence;
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
    cleanupRevision: writer.requestRevision,
  });
  const permission = await readApproval(request.projectRoot, checks);
  if ("failure" in permission) {
    // The crew state holds the approvals and the cleanup record alike, so a file that cannot
    // answer is reported as itself rather than as something about the checkout.
    return permission.failure;
  }

  const approval = permission.outcome;
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
    const opened = await writer.intend({
      operationId,
      intent: {
        kind: KIND,
        workspaceId: identity.checkout.workspaceId,
        worktreePath: context.dispatch.worktreePath,
        approvalId: approval.approval.approvalId,
      },
      detail: `Approved removal of ${context.dispatch.worktreePath} was requested.`,
    });
    if (opened.status !== "recorded") {
      return opened;
    }
  }

  const removed = await OperativeCleanup.remove({
    repoRoot: request.projectRoot,
    workspaceId: identity.checkout.workspaceId,
    worktreePath: context.dispatch.worktreePath,
  });

  if (removed.status === "uncertain") {
    const written = await writer.settle({
      state: "uncertain",
      detail: removed.detail,
      operation: { id: operationId, state: "uncertain" },
    });
    return written.status === "recorded"
      ? { status: "uncertain", report: writer.report("uncertain"), detail: removed.detail }
      : written;
  }

  if (removed.status !== "removed") {
    const detail =
      removed.status === "failed" ? `${removed.code}: ${removed.detail}` : removed.detail;
    const written = await writer.settle({
      state: "failed",
      detail,
      operation: { id: operationId, state: "failed" },
    });
    return written.status === "recorded"
      ? { status: "failed", report: writer.report("failed"), detail }
      : written;
  }

  const written = await writer.settle({
    state: "done",
    detail: `Herdr removed ${context.dispatch.worktreePath}.`,
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
    report: writer.report(
      "done",
      final.status === "ok" ? (final.context.cleanups.get(KIND) ?? held) : held,
    ),
    repeated: written.repeated,
  };
}
