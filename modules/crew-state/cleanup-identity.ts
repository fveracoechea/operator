import { OperativeCleanup } from "../operative-cleanup/main.ts";
import { OperativeDispatch } from "../operative-dispatch/main.ts";
import type { CleanupContext } from "./cleanup-context.ts";

export type IdentityMismatch = { field: string; recorded: string; found: string };

/** The Herdr handles one removal acts on, each one read back from Herdr rather than assumed. */
export type VerifiedCheckout = { workspaceId: string; branch: string };

export type IdentityMatch =
  | { status: "matched"; paneId: string; checkout: VerifiedCheckout }
  | { status: "checkout-absent"; worktreePath: string }
  | { status: "workspace-handle-missing"; attemptId: string; missing: string[] }
  | { status: "unrelated-resource"; worktreePath: string; detail: string }
  | { status: "identity-mismatch"; mismatches: IdentityMismatch[] }
  | { status: "checkout-unknown"; detail: string }
  | { status: "checkout-in-use"; attemptIds: string[] };

type Confirmed = { value: string } | { mismatch: IdentityMismatch };

/**
 * Confirms one name against what the holder of the resource actually reports.
 * A field the holder does not name is a mismatch, never a match: Operator would otherwise act
 * on the value it recorded itself, which proves nothing about the resource in front of it.
 */
function confirm(field: string, recorded: string, found: string | null): Confirmed {
  return found === recorded
    ? { value: recorded }
    : { mismatch: { field, recorded, found: found ?? "none" } };
}

function mismatchesOf(confirmed: Confirmed[]): IdentityMismatch[] {
  return confirmed.flatMap((one) => ("mismatch" in one ? [one.mismatch] : []));
}

/**
 * Proves that every name this cleanup would act on belongs to this attempt.
 * The repository, the assignment, the attempt, the Herdr handles, the checkout on disk, its
 * branch, and the attempts still writing there must all agree before any destructive step.
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

  const workspaceId = dispatch.workspaceId;
  const paneId = dispatch.paneId;
  if (workspaceId === null || paneId === null) {
    return {
      status: "workspace-handle-missing",
      attemptId: attempt.id,
      missing: [
        ...(workspaceId === null ? ["workspace"] : []),
        ...(paneId === null ? ["pane"] : []),
      ],
    };
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

  const stated = mismatchesOf([
    confirm("repository", request.projectRoot, reference.controllingCheckout),
    confirm("assignment", assignment.id, reference.assignmentId),
    confirm("attempt", attempt.id, reference.attemptId),
    confirm("worktree", dispatch.worktreePath, reference.worktreePath),
    confirm("branch", dispatch.branch, reference.branch),
  ]);
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
    return { status: "checkout-absent", worktreePath: dispatch.worktreePath };
  }

  const path = confirm("worktree", dispatch.worktreePath, checkout.value.path);
  const workspace = confirm("workspace", workspaceId, checkout.value.workspaceId);
  const branch = confirm("branch", dispatch.branch, checkout.value.branch);
  if ("mismatch" in path || "mismatch" in workspace || "mismatch" in branch) {
    return {
      status: "identity-mismatch",
      mismatches: mismatchesOf([path, workspace, branch]),
    };
  }

  // The handles a removal acts on are the ones Herdr just named, never the recorded copies.
  return {
    status: "matched",
    paneId,
    checkout: { workspaceId: workspace.value, branch: branch.value },
  };
}
