import {
  DoAsync,
  Err,
  ErrAsync,
  Ok,
  OkAsync,
  fromPromise,
  fromSafePromise,
  type AsyncResult,
  type Result,
} from "unthrown";
import { DeviceState } from "../device-state/main.ts";
import { Herdr } from "../herdr/main.ts";
import { ToolInvocation } from "../tool-invocation/main.ts";
import { chooseNames, launchBase } from "./names.ts";
import { gitBranches, qualify, type Failure, type Paths } from "./observations.ts";

type Launch = {
  name: string;
  state: string;
  paneId: string | null;
  tabId: string | null;
  herdrSocket: string | null;
  worktreePath: string;
  branch: string | null;
};

/**
 * The names that the PR assignment takes over, and the undo of their renames. The undo takes the
 * refusal that stopped the promotion.
 */
type Handover = {
  name: string | null;
  branch: string;
  undo: (refused: Result<unknown, Failure>) => AsyncResult<void, Failure>;
};

/** One rename back, and what stays when it fails. */
type Step = { stayed: string; run: () => AsyncResult<unknown, Failure> };

function renameBranch(checkout: string, from: string, to: string) {
  return fromPromise(
    () =>
      ToolInvocation.run({
        tool: "git",
        args: ["-C", checkout, "branch", "-m", from, to],
        timeoutMs: 60000,
      }),
    // Stryker disable next-line ConditionalExpression: equivalent: qualify passes any cause without an I/O code to defect, as the other branch does
    (cause, defect) => (cause instanceof Error ? qualify(cause, defect) : defect(cause)),
  ).flatMap((result): Result<void, Failure> =>
    // Stryker disable next-line ConditionalExpression: equivalent: an invocation that did not complete has no exit code, so the exit check alone refuses it
    result.status === "completed" && result.exitCode === 0
      ? Ok(undefined)
      : Err({
          reason: "promotion_branch_failed",
          detail: `git branch -m ${from} ${to} failed: ${result.status === "completed" ? result.stderr.trim() : result.detail} Nothing changed.`,
        }),
  );
}

/**
 * A running worker is handed over only on its own Herdr server, while Herdr still names it.
 * A worker that Herdr no longer lists has stopped, so a later dispatch starts the PR assignment.
 * A live worker answers Herdr's agent names, which the new launch name must avoid.
 */
function liveWorker(launch: Launch, callerSocket: string | null) {
  if (launch.state !== "running" || launch.paneId === null) return OkAsync(null);
  if (callerSocket !== launch.herdrSocket)
    return ErrAsync<Failure>({
      reason: "promotion_herdr_server",
      detail: `Pane ${launch.paneId} belongs to another Herdr server. Promote in a pane of that server. Nothing changed.`,
    });
  return Herdr.agentNames().map((agents) => (agents.includes(launch.name) ? agents : null));
}

/** Runs every step, also after a failed one, and refuses with each rename that stayed. */
function restore(refused: Result<unknown, Failure>, steps: Step[]) {
  const reason = refused.tag === "Err" ? refused.error.reason : "defect";
  return fromSafePromise(async () => {
    const stayed: string[] = [];
    for (const step of steps) if ((await step.run()).tag !== "Ok") stayed.push(step.stayed);
    return stayed;
  }).flatMap((stayed): Result<void, Failure> =>
    stayed.length === 0
      ? Ok(undefined)
      : Err({
          reason: "promotion_undo_failed",
          detail: `The promotion was not recorded (${reason}), and these renames stayed: ${stayed.join(" ")} Restore them, then promote again.`,
        }),
  );
}

/**
 * The worktree branch takes the PR assignment's branch before its first push, and a running
 * worker's Herdr name and tab take its launch name. A taken name or branch gets a suffix.
 * `undo` restores each rename, for a promotion that the database then refuses, and answers
 * the detail of each rename that it could not restore. ADR-0023.
 */
export function handOver(input: {
  paths: Paths;
  checkout: string;
  callerSocket: string | null;
  assignment: { key: string; trackerKey: string; branch: string };
  launch: Launch;
}) {
  const { checkout, launch } = input;
  const from = launch.branch;
  return DoAsync()
    .bind("agents", () => liveWorker(launch, input.callerSocket))
    .bind("recorded", () => DeviceState.launchNames(input.paths))
    .bind("branches", () => gitBranches(checkout))
    .bind("names", ({ agents, recorded, branches }) => {
      const names = chooseNames({
        base: launchBase({ completion: "pr", ...input.assignment }),
        branch: input.assignment.branch,
        takenNames: new Set([...(agents ?? []), ...recorded]),
        // The worktree's own branch is free for itself.
        takenBranches: new Set([...branches].filter((branch) => branch !== from)),
      });
      return names === null
        ? Err<Failure>({
            reason: "launch_name_exhausted",
            detail: "No free launch name or branch remains. Nothing changed.",
          })
        : Ok({ name: names.name, branch: names.branch ?? input.assignment.branch });
    })
    .flatTap(({ names }) =>
      from === null || from === names.branch
        ? OkAsync(undefined)
        : renameBranch(checkout, from, names.branch),
    )
    .flatMap(({ agents, names }) => {
      const branchBack: Step[] =
        from === null || from === names.branch
          ? []
          : [
              {
                stayed: `Branch ${names.branch} was not renamed back to ${from}.`,
                run: () => renameBranch(checkout, names.branch, from),
              },
            ];
      const kept: Handover = {
        name: null,
        branch: names.branch,
        undo: (refused) => restore(refused, branchBack),
      };
      const paneId = launch.paneId;
      // Stryker disable next-line ConditionalExpression: equivalent: a live worker always has its pane
      if (agents === null || paneId === null) return OkAsync(kept);
      const tabId = launch.tabId;
      const agentBack: Step = {
        stayed: `Herdr agent ${names.name} in pane ${paneId} was not renamed back to ${launch.name}.`,
        run: () => Herdr.renameAgent({ paneId, name: launch.name }),
      };
      const tabBack: Step[] =
        tabId === null
          ? []
          : [
              {
                stayed: `Tab ${tabId} was not relabelled ${launch.name}.`,
                run: () => Herdr.renameTab({ tabId, label: launch.name }),
              },
            ];
      const taken: Handover = {
        name: names.name,
        branch: names.branch,
        undo: (refused) => restore(refused, [agentBack, ...tabBack, ...branchBack]),
      };
      return fromSafePromise(async () => {
        const renamed = await Herdr.renameAgent({ paneId, name: names.name });
        if (renamed.tag !== "Ok") {
          const undone = await kept.undo(renamed);
          // Stryker disable next-line ArrowFunction: equivalent: the callback runs only for a success
          if (undone.tag !== "Ok") return undone.map(() => taken);
          // The refusal passes through. Its callback never runs.
          // Stryker disable next-line ArrowFunction: equivalent: the callback runs only for a success
          return renamed.map(() => taken);
        }
        // Herdr labels a worktree workspace's root tab with the launch name.
        const labelled =
          tabId === null ? Ok(undefined) : await Herdr.renameTab({ tabId, label: names.name });
        if (labelled.tag !== "Ok") {
          const undone = await restore(labelled, [agentBack, ...branchBack]);
          // Stryker disable next-line ArrowFunction: equivalent: the callback runs only for a success
          if (undone.tag !== "Ok") return undone.map(() => taken);
          // The refusal passes through. Its callback never runs.
          // Stryker disable next-line ArrowFunction: equivalent: the callback runs only for a success
          return labelled.map(() => taken);
        }
        return Ok(taken);
      }).flatMap((result): Result<Handover, Failure> => result);
    });
}
