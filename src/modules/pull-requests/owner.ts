import { isCodedError } from "../../lib/coded-error.ts";
import { realPathOrNull } from "../../lib/real-path.ts";
// Bun has no realpath API.
import { realpath } from "node:fs/promises";
import { Err, ErrAsync, Ok, fromPromise, type AsyncResult } from "unthrown";
import { DeviceState } from "../device-state/main.ts";
import type { OperatorHome } from "../operator-home/main.ts";
import { Projects } from "../projects/main.ts";
import { ToolInvocation } from "../tool-invocation/main.ts";
import { WorkSources } from "../work-sources/main.ts";
import type { Refusal, RefusalContext } from "../../lib/cli-result.ts";

export type Paths = ReturnType<typeof OperatorHome.resolve>;
type OwnerFailure = RefusalContext & {
  reason:
    | "pr_worktree_unrecorded"
    | "pr_owner_inactive"
    | "pr_repository_mismatch"
    | "pr_branch_mismatch";
  detail: string;
};
type Owners = Extract<ReturnType<typeof DeviceState.worktreeOwners>, { tag: "Ok" }>["value"];
type Recorded = Owners[number] & { worktreePath: string };
export type Owner = Recorded & { branch: string; parkedHead?: string };

export function qualify<C, T>(cause: C, defect: (cause: C) => T) {
  if (
    isCodedError(cause) &&
    ["ENOENT", "EACCES", "EPERM", "EIO", "ENOTDIR", "ELOOP"].includes(cause.code)
  )
    return {
      reason: "pr_io_failed",
      detail: String(cause),
      next: {
        decider: "super-agent" as const,
        question: "How should the PR worktree IO failure be corrected without losing work?",
      },
      state: { code: cause.code },
    };
  return defect(cause);
}

async function git(cwd: string, args: string[]) {
  const result = await ToolInvocation.run({ tool: "git", args, cwd, timeoutMs: 10000 });
  // Stryker disable next-line ConditionalExpression: equivalent: a result that did not complete has no exit code, so the exit code check alone returns null
  return result.status === "completed" && result.exitCode === 0 ? result.stdout.trim() : null;
}

const nothing = "Nothing was read from GitHub or changed.";

/** The caller's real Git top level must have at most one running recorded owner. */
async function recorded(cwd: string, owners: Owners): Promise<Recorded | OwnerFailure> {
  const top = await git(cwd, ["rev-parse", "--show-toplevel"]);
  if (top === null)
    return {
      reason: "pr_worktree_unrecorded",
      detail: `Run PR commands inside the recorded worktree of your assignment. ${nothing}`,
      next: {
        command: "operator next",
        why: "Locate the assignment's recorded worktree before running a PR command.",
      },
      state: { gitTopLevel: null },
    };
  const real = await realpath(top);
  const matches: Recorded[] = [];
  for (const row of owners)
    // Stryker disable next-line ConditionalExpression: equivalent: a null path has no real path, so it never equals the caller's top level
    if (row.worktreePath !== null && (await realPathOrNull(row.worktreePath)) === real)
      matches.push({ ...row, worktreePath: row.worktreePath });
  const runningOwners = matches.filter((row) => row.launchState === "running");
  if (runningOwners.length > 1)
    return {
      reason: "pr_worktree_unrecorded",
      detail: `${real} has multiple running recorded owners. Resolve the ambiguous worktree ownership before running a PR command. ${nothing}`,
      next: {
        decider: "super-agent",
        question: "Which recorded assignment should own this worktree?",
      },
      state: {
        worktree: real,
        ambiguous: true,
        launchIds: runningOwners.map((row) => row.launchId),
      },
    };
  return (
    runningOwners[0] ??
    matches[0] ?? {
      reason: "pr_worktree_unrecorded",
      detail: `${real} is not the recorded worktree of an assignment. ${nothing}`,
      next: {
        command: "operator next",
        why: "Locate the assignment's recorded worktree before running a PR command.",
      },
      state: { worktree: real, recorded: false },
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
        next: {
          decider: "super-agent",
          question: "Which recorded owner should continue this PR assignment?",
        },
        state: {
          assignment: owner.assignmentState,
          source: owner.sourceState,
          launch: owner.launchState,
          completion: owner.completion,
          branch,
        },
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
      next: {
        decider: "super-agent",
        question:
          "How should this worktree's repository mismatch be resolved while preserving its work?",
      },
      state: { repository: owner.repository, matches: false },
    };
  const head = await git(owner.worktreePath, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
  return head === owner.branch
    ? owner
    : {
        reason: "pr_branch_mismatch",
        detail: `The worktree must be on the recorded branch ${owner.branch}, not ${head ?? "a detached HEAD"}. ${nothing}`,
        next: {
          decider: "super-agent",
          question: "How should the recorded PR branch be restored without losing local work?",
        },
        state: { expected: owner.branch, actual: head },
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

/** A supervisor selects only a parked assignment, never a live worker's PR. */
export function resolveParkedOwner(input: {
  paths: Paths;
  cwd: string;
  sourceId: string;
  assignment: string;
}): AsyncResult<Owner, Refusal> {
  return WorkSources.checkSupervisor(input).flatMap(() =>
    WorkSources.show(input).flatMap((source): AsyncResult<Owner, Refusal> => {
      const parking = source?.pullRequests.find(
        (row) => row.assignment === input.assignment,
      )?.parking;
      if (parking?.state !== "parked" || parking.head === null)
        return ErrAsync(inactiveParked(input.sourceId, parking?.state, undefined));
      const head = parking.head;
      return DeviceState.worktreeOwners(input.paths)
        .toAsync()
        .flatMap((owners) =>
          fromPromise(async () => {
            const owner = owners.find(
              (row) =>
                row.sourceId === input.sourceId &&
                row.assignment === input.assignment &&
                row.repository === source?.repository,
            );
            if (!parkedOwnerRecord(owner, parking.launchId))
              return inactiveParked(input.sourceId, parking.state, owner?.launchState);
            return findParkedRepository(input.paths, owner, owners);
          }, qualify).flatMap((found): AsyncResult<Owner, Refusal> =>
            "reason" in found
              ? ErrAsync(found)
              : DeviceState.checkParkedMergeOwner(input.paths, found.launchId, head)
                  .toAsync()
                  .map(() => ({ ...found, parkedHead: head })),
          ),
        );
    }),
  );
}

function parkedOwnerRecord(
  owner: Owners[number] | undefined,
  launchId: string | null,
): owner is Owner {
  return (
    owner?.launchId === launchId &&
    owner.sourceState === "open" &&
    owner.assignmentState === "pr-open" &&
    owner.completion === "pr" &&
    owner.branch !== null &&
    owner.worktreePath !== null
  );
}

function inactiveParked(sourceId: string, state: string | undefined, launch: string | undefined) {
  return {
    reason: "pr_owner_inactive" as const,
    detail:
      "The selected assignment has no eligible parked PR owner. Nothing was read from GitHub or changed.",
    next: {
      command: `operator next --source ${sourceId}`,
      why: "Read the selected assignment's current action.",
    },
    state: { parked: state === "parked", launch: launch ?? null },
  };
}

async function findParkedRepository(
  paths: Paths,
  owner: Owner,
  owners: Owners,
): Promise<Owner | OwnerFailure> {
  const retained = await realPathOrNull(owner.worktreePath);
  for (const other of owners) {
    if (
      other.launchId === owner.launchId ||
      !["starting", "running"].includes(other.launchState) ||
      other.worktreePath === null
    )
      continue;
    if (retained !== null && (await realPathOrNull(other.worktreePath)) === retained)
      return {
        reason: "pr_worktree_unrecorded",
        detail:
          "A live launch now owns the retained worktree. Nothing was read from GitHub or changed.",
        next: {
          decider: "super-agent",
          question: "Which assignment should own the retained worktree before merging?",
        },
        state: { worktree: retained, launchId: other.launchId },
      };
  }
  if (!(await sameRepository(paths, owner)))
    return {
      reason: "pr_repository_mismatch",
      detail:
        "The parked worktree no longer belongs to the registered repository. Nothing changed.",
      next: {
        decider: "super-agent",
        question: "How should the parked worktree's repository be restored without losing work?",
      },
      state: { repository: owner.repository, matches: false },
    };
  const head = await git(owner.worktreePath, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
  return head === owner.branch
    ? owner
    : {
        reason: "pr_branch_mismatch",
        detail: "The parked worktree is not on its recorded branch. Nothing changed.",
        next: {
          decider: "super-agent",
          question: "How should the parked worktree's branch be restored without losing work?",
        },
        state: { expected: owner.branch, actual: head },
      };
}
