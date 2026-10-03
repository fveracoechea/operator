import type { ApprovalCheck } from "./approval-input.ts";
import { matchApproval } from "./approvals.ts";
import type { ApprovalOutcome } from "./cleanup-machine.ts";
import { readState } from "./operations.ts";

/** The one action a person approves before any Operative checkout is removed. */
const WORKTREE_DELETE = "worktree_delete";

/**
 * Finds the approval that covers one removal, if this crew holds one. Either of two grants is
 * enough. A per-cleanup grant names this checkout at the revision it was inspected at. A workflow
 * grant names the repository at the revision of the registered work and the Operator that owns
 * it. A state file that cannot answer is reported as the state failure it is, because the
 * resource a person would then have to settle is the crew state and not the checkout.
 */
export async function removalApproval(request: {
  projectRoot: string;
  worktreePath: string;
  workflowRevision: string;
  cleanupRevision: string;
}): Promise<ApprovalOutcome> {
  const checks: ApprovalCheck[] = [
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
  const matches = await readState(request.projectRoot, (db) =>
    checks.map((check) => matchApproval(db, check)),
  );
  if (!Array.isArray(matches)) {
    return { status: "unreadable", failure: matches };
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
