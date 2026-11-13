import { isCodedError } from "../../lib/coded-error.ts";
import { realPathOrNull } from "../../lib/real-path.ts";
// Bun has no realpath API.
import { realpath } from "node:fs/promises";
import { Err, Ok, fromPromise } from "unthrown";
import { DeviceState } from "../device-state/main.ts";
import type { OperatorHome } from "../operator-home/main.ts";
import { Projects } from "../projects/main.ts";
import { ToolInvocation } from "../tool-invocation/main.ts";

export type Paths = ReturnType<typeof OperatorHome.resolve>;
type OwnerFailure = {
  reason:
    | "pr_worktree_unrecorded"
    | "pr_owner_inactive"
    | "pr_repository_mismatch"
    | "pr_branch_mismatch";
  detail: string;
};
type Owners = Extract<ReturnType<typeof DeviceState.worktreeOwners>, { tag: "Ok" }>["value"];
type Recorded = Owners[number] & { worktreePath: string };
export type Owner = Recorded & { branch: string };

export function qualify<C, T>(cause: C, defect: (cause: C) => T) {
  if (
    isCodedError(cause) &&
    ["ENOENT", "EACCES", "EPERM", "EIO", "ENOTDIR", "ELOOP"].includes(cause.code)
  )
    return { reason: "pr_io_failed", detail: String(cause) };
  return defect(cause);
}

async function git(cwd: string, args: string[]) {
  const result = await ToolInvocation.run({ tool: "git", args, cwd, timeoutMs: 10000 });
  // Stryker disable next-line ConditionalExpression: equivalent: a result that did not complete has no exit code, so the exit code check alone returns null
  return result.status === "completed" && result.exitCode === 0 ? result.stdout.trim() : null;
}

const nothing = "Nothing was read from GitHub or changed.";

/** The caller's real Git top level must be a recorded worktree. A running owner wins a reused path. */
async function recorded(cwd: string, owners: Owners): Promise<Recorded | OwnerFailure> {
  const top = await git(cwd, ["rev-parse", "--show-toplevel"]);
  if (top === null)
    return {
      reason: "pr_worktree_unrecorded",
      detail: `Run PR commands inside the recorded worktree of your assignment. ${nothing}`,
    };
  const real = await realpath(top);
  const matches: Recorded[] = [];
  for (const row of owners)
    // Stryker disable next-line ConditionalExpression: equivalent: a null path has no real path, so it never equals the caller's top level
    if (row.worktreePath !== null && (await realPathOrNull(row.worktreePath)) === real)
      matches.push({ ...row, worktreePath: row.worktreePath });
  return (
    matches.find((row) => row.launchState === "running") ??
    matches[0] ?? {
      reason: "pr_worktree_unrecorded",
      detail: `${real} is not the recorded worktree of an assignment. ${nothing}`,
    }
  );
}

function running(owner: Recorded): Owner | OwnerFailure {
  const branch = owner.branch;
  return owner.launchState === "running" &&
    owner.sourceState === "open" &&
    owner.completion === "pr" &&
    ["running", "pr-open"].includes(owner.assignmentState) &&
    branch !== null
    ? { ...owner, branch }
    : {
        reason: "pr_owner_inactive",
        detail: `This worktree belongs to assignment ${owner.assignment}, which has no running PR owner. ${nothing}`,
      };
}

/** The worktree shares the controlling checkout's repository, which still has its identity. */
async function sameRepository(paths: Paths, owner: Owner) {
  const args = ["rev-parse", "--path-format=absolute", "--git-common-dir"];
  const common = await git(owner.worktreePath, args);
  const controller = await git(owner.checkout, args);
  const project = await Projects.current({ paths, cwd: owner.checkout });
  return (
    // Stryker disable next-line ConditionalExpression,LogicalOperator: equivalent: the caller's top level is this worktree, so Git names its common folder, and a null controller folder never equals that real path
    common !== null &&
    // Stryker disable next-line ConditionalExpression: equivalent: a null controller folder has a null real path, which never equals the worktree common folder
    controller !== null &&
    (await realPathOrNull(common)) === (await realPathOrNull(controller)) &&
    project.tag === "Ok" &&
    project.value.data.repository === owner.repository
  );
}

/**
 * The real Git top level of the caller is the only selector. It must be the recorded worktree
 * of the running latest start of an open PR assignment, in the project's own repository.
 */
async function find(paths: Paths, cwd: string, owners: Owners): Promise<Owner | OwnerFailure> {
  const found = await recorded(cwd, owners);
  if ("reason" in found) return found;
  const owner = running(found);
  if ("reason" in owner) return owner;
  if (!(await sameRepository(paths, owner)))
    return {
      reason: "pr_repository_mismatch",
      detail: `This worktree is not a worktree of the registered ${owner.repository} checkout. ${nothing}`,
    };
  const head = await git(owner.worktreePath, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
  return head === owner.branch
    ? owner
    : {
        reason: "pr_branch_mismatch",
        detail: `The worktree must be on the recorded branch ${owner.branch}, not ${head ?? "a detached HEAD"}. ${nothing}`,
      };
}

export function resolveOwner(input: { paths: Paths; cwd: string }) {
  return DeviceState.worktreeOwners(input.paths)
    .toAsync()
    .flatMap((owners) =>
      fromPromise(() => find(input.paths, input.cwd, owners), qualify).flatMap((found) =>
        "reason" in found ? Err(found) : Ok(found),
      ),
    );
}
