import { OperativeCleanup } from "../operative-cleanup/main.ts";
import { OperativeDispatch } from "../operative-dispatch/main.ts";
import type { CleanupContext } from "./cleanup-context.ts";

export type IdentityMismatch = { field: string; recorded: string; found: string };

export type IdentityMatch =
  | { status: "matched"; workspaceId: string; paneId: string; checkoutPresent: boolean }
  | { status: "workspace-handle-missing"; attemptId: string; missing: string[] }
  | { status: "unrelated-resource"; worktreePath: string; detail: string }
  | { status: "identity-mismatch"; mismatches: IdentityMismatch[] }
  | { status: "checkout-unknown"; detail: string }
  | { status: "checkout-in-use"; attemptIds: string[] };

function differs(field: string, recorded: string, found: string | null): IdentityMismatch | null {
  return found === null || found === recorded ? null : { field, recorded, found };
}

/**
 * Proves that every name this cleanup would act on belongs to this attempt.
 * The repository, the assignment, the attempt, the Herdr handles, the checkout on disk, its
 * occupants, and the attempts still writing there must all agree before any destructive step.
 */
export async function matchIdentity(request: {
  projectRoot: string;
  context: CleanupContext;
}): Promise<IdentityMatch> {
  const { dispatch, attempt, assignment } = request.context;

  // Operator disposes of Operative checkouts only. The controlling checkout is never a target.
  if (dispatch.worktreePath === request.projectRoot) {
    return {
      status: "unrelated-resource",
      worktreePath: dispatch.worktreePath,
      detail: "That path is the controlling checkout, not an Operative worktree.",
    };
  }

  const missing = [
    ...(dispatch.workspaceId === null ? ["workspace"] : []),
    ...(dispatch.paneId === null ? ["pane"] : []),
  ];
  if (dispatch.workspaceId === null || dispatch.paneId === null) {
    return { status: "workspace-handle-missing", attemptId: attempt.id, missing };
  }

  if (request.context.otherOccupants.length > 0) {
    return { status: "checkout-in-use", attemptIds: request.context.otherOccupants };
  }

  const reference = await OperativeDispatch.readReference({
    worktreePath: dispatch.worktreePath,
  });
  if (reference === null) {
    return {
      status: "identity-mismatch",
      mismatches: [{ field: "control-reference", recorded: dispatch.worktreePath, found: "none" }],
    };
  }

  const stated = [
    differs("repository", request.projectRoot, reference.controllingCheckout),
    differs("assignment", assignment.id, reference.assignmentId),
    differs("attempt", attempt.id, reference.attemptId),
    differs("worktree", dispatch.worktreePath, reference.worktreePath),
    differs("branch", dispatch.branch, reference.branch),
  ].flatMap((one) => (one === null ? [] : [one]));
  if (stated.length > 0) {
    return { status: "identity-mismatch", mismatches: stated };
  }

  const checkout = await OperativeCleanup.findCheckout({
    repoRoot: request.projectRoot,
    path: dispatch.worktreePath,
  });
  if (checkout.status === "unknown") {
    return { status: "checkout-unknown", detail: checkout.detail };
  }
  if (checkout.status === "absent") {
    return {
      status: "matched",
      workspaceId: dispatch.workspaceId,
      paneId: dispatch.paneId,
      checkoutPresent: false,
    };
  }

  const held = [
    differs("worktree", dispatch.worktreePath, checkout.value.path),
    differs("workspace", dispatch.workspaceId, checkout.value.workspaceId),
    differs("branch", dispatch.branch, checkout.value.branch),
  ].flatMap((one) => (one === null ? [] : [one]));

  return held.length > 0
    ? { status: "identity-mismatch", mismatches: held }
    : {
        status: "matched",
        workspaceId: dispatch.workspaceId,
        paneId: dispatch.paneId,
        checkoutPresent: true,
      };
}
