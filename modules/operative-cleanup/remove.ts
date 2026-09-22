import { HerdrControl } from "../herdr-control/main.ts";

export type RemoveOutcome =
  | { status: "removed" }
  | { status: "still-present"; detail: string }
  | { status: "failed"; code: string; detail: string }
  | { status: "uncertain"; detail: string };

/**
 * Removes one Herdr-managed checkout and reads back whether it is gone.
 * Removal is never forced, deletes no branch, closes no workspace group, and runs no Git or
 * filesystem deletion of its own, so an unsafe checkout survives the request.
 */
export async function removeCheckout(request: {
  repoRoot: string;
  workspaceId: string;
  worktreePath: string;
}): Promise<RemoveOutcome> {
  const removed = await HerdrControl.removeWorktree({ workspaceId: request.workspaceId });
  if (removed.status === "uncertain") {
    return { status: "uncertain", detail: removed.detail };
  }

  const found = await HerdrControl.findWorktree({
    repoRoot: request.repoRoot,
    path: request.worktreePath,
  });
  if (found.status === "unknown") {
    return { status: "uncertain", detail: found.detail };
  }
  if (found.status === "absent") {
    return { status: "removed" };
  }

  return removed.status === "failed"
    ? { status: "failed", code: removed.code, detail: removed.detail }
    : { status: "still-present", detail: `Herdr still holds ${request.worktreePath}.` };
}
