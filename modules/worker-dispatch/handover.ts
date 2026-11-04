import {
  DoAsync,
  Err,
  ErrAsync,
  Ok,
  OkAsync,
  fromPromise,
  fromSafePromise,
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

/** The names that the PR assignment takes over, and the undo of their renames. */
type Handover = { name: string | null; branch: string; undo: () => Promise<void> };

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
 */
function liveWorker(launch: Launch, callerSocket: string | null) {
  if (launch.state !== "running" || launch.paneId === null) return OkAsync(false);
  if (callerSocket !== launch.herdrSocket)
    return ErrAsync<Failure>({
      reason: "promotion_herdr_server",
      detail: `Pane ${launch.paneId} belongs to another Herdr server. Promote in a pane of that server. Nothing changed.`,
    });
  return Herdr.agentNames().map((agents) => agents.includes(launch.name));
}

/**
 * The worktree branch takes the PR assignment's branch before its first push, and a running
 * worker's Herdr name and tab take its launch name. A taken name or branch gets a suffix.
 * `undo` restores each rename, for a promotion that the database then refuses. ADR-0023.
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
    .bind("live", () => liveWorker(launch, input.callerSocket))
    .bind("agents", ({ live }) => (live ? Herdr.agentNames() : OkAsync<string[]>([])))
    .bind("recorded", () => DeviceState.launchNames(input.paths))
    .bind("branches", () => gitBranches(checkout))
    .bind("names", ({ agents, recorded, branches }) => {
      const names = chooseNames({
        base: launchBase({ completion: "pr", ...input.assignment }),
        branch: input.assignment.branch,
        takenNames: new Set([...agents, ...recorded]),
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
    .flatMap(({ live, names }) => {
      const kept: Handover = {
        name: null,
        branch: names.branch,
        async undo() {
          if (from !== null && from !== names.branch)
            await renameBranch(checkout, names.branch, from);
        },
      };
      const paneId = launch.paneId;
      // Stryker disable next-line ConditionalExpression: equivalent: a live worker always has its pane
      if (!live || paneId === null) return OkAsync(kept);
      return fromSafePromise(async () => {
        const renamed = await Herdr.renameAgent({ paneId, name: names.name });
        if (renamed.tag !== "Ok") {
          await kept.undo();
          // The refusal passes through. Its callback never runs.
          // Stryker disable next-line ArrowFunction: equivalent: the callback runs only for a success
          return renamed.map(() => kept);
        }
        // Herdr labels a worktree workspace's root tab with the launch name.
        if (launch.tabId !== null)
          await Herdr.renameTab({ tabId: launch.tabId, label: names.name });
        const taken: Handover = {
          name: names.name,
          branch: names.branch,
          async undo() {
            await Herdr.renameAgent({ paneId, name: launch.name });
            if (launch.tabId !== null)
              await Herdr.renameTab({ tabId: launch.tabId, label: launch.name });
            await kept.undo();
          },
        };
        return Ok(taken);
      }).flatMap((result) => result);
    });
}
