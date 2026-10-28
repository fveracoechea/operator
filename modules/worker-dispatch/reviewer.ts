import { realPathOrNull } from "../../lib/real-path.ts";
import { DoAsync, Err, Ok, fromPromise, type Result } from "unthrown";
import { DeviceState } from "../device-state/main.ts";
import { Herdr } from "../herdr/main.ts";
import { Projects } from "../projects/main.ts";
import { ToolInvocation } from "../tool-invocation/main.ts";
import { ensureWorkspace, launchSettings, preparedAgain } from "./launch-checks.ts";
import { chooseNames } from "./names.ts";
import {
  gitBranches,
  projectWorkspace,
  qualify,
  waitForPreparation,
  type Failure,
  type Paths,
} from "./observations.ts";

type Recorded = {
  name?: string;
  branch?: string;
  launch?: string;
  workspaceId?: string;
  tabId?: string;
  paneId?: string;
  worktreePath?: string;
  worktreeWorkspaceId?: string;
  herdrSocket?: string;
};
export type ReviewerLaunch = {
  paths: Paths;
  checkout: string;
  repository: string;
  number: number;
  /** The PR head that the reviewer worktree starts at. */
  head: string;
  /**
   * A first start refuses a PR that moved since its read. A replacement keeps the head that the
   * request recorded, so the next wait still reports newer commits as a round.
   */
  exactHead: boolean;
  nameBase: string;
  branchBase: string;
  profile: string | undefined;
  /** A worktree that an earlier failed start recorded. A retry reopens it. */
  reuse: { path: string; branch: string } | null;
  brief: { file: string; render: (placement: { worktree: string; branch: string }) => string };
  /** Records each resource as Herdr returns it, so a failed start keeps it visible. */
  record: (change: Recorded) => Result<unknown, Failure>;
};

async function git(cwd: string, args: string[]) {
  const result = await ToolInvocation.run({ tool: "git", args, cwd, timeoutMs: 120000 });
  return result.status === "completed" && result.exitCode === 0 ? result.stdout.trim() : null;
}

/**
 * Fetches the PR head into a remote-tracking ref of the controlling checkout. It writes no local
 * branch, so nothing there can be pushed. A head that moved since the read refuses the start.
 */
function fetchHead(input: ReviewerLaunch) {
  return Projects.githubRemote({ checkout: input.checkout, repository: input.repository }).flatMap(
    (remote) =>
      fromPromise(
        async () => {
          if (remote === null)
            return Err<Failure>({
              reason: "review_fetch_failed",
              detail: `The controlling checkout has no remote for ${input.repository}. Nothing was launched.`,
            });
          const ref = `refs/remotes/${remote}/pr/${input.number}`;
          const fetched = await git(input.checkout, [
            "fetch",
            "--no-tags",
            "--quiet",
            remote,
            `+refs/pull/${input.number}/head:${ref}`,
          ]);
          const head = fetched === null ? null : await git(input.checkout, ["rev-parse", ref]);
          if (
            head !== null &&
            !input.exactHead &&
            (await git(input.checkout, ["cat-file", "-e", `${input.head}^{commit}`])) !== null
          )
            return Ok(input.head);
          if (head === null)
            return Err<Failure>({
              reason: "review_fetch_failed",
              detail: `Git could not fetch PR #${input.number} from ${remote}. Nothing was launched.`,
            });
          return head === input.head
            ? Ok(head)
            : Err<Failure>({
                reason: "review_head_moved",
                detail: `PR #${input.number} moved to ${head} after it was read. Start the reviewer again. Nothing was launched.`,
              });
        },
        (cause, defect) => (cause instanceof Error ? qualify(cause, defect) : defect(cause)),
      ).flatMap((result) => result),
  );
}

/** Every taken Herdr name, Git branch, or recorded launch name is skipped, never adopted. */
function names(input: ReviewerLaunch) {
  return DoAsync()
    .bind("workspace", () => projectWorkspace(input.checkout))
    .bind("agents", () => Herdr.agentNames())
    .bind("tabs", ({ workspace }) =>
      workspace.workspaceId === null ? Ok([]) : Herdr.tabLabels(workspace.workspaceId),
    )
    .bind("recorded", () => DeviceState.launchNames(input.paths))
    .bind("branches", () => gitBranches(input.checkout))
    .bind("chosen", ({ workspace, agents, tabs, recorded, branches }) => {
      const chosen = chooseNames({
        base: input.nameBase,
        branch: input.reuse === null ? input.branchBase : null,
        takenNames: new Set([...agents, ...tabs, ...workspace.labels, ...recorded]),
        takenBranches: branches,
      });
      return chosen === null
        ? Err<Failure>({
            reason: "launch_name_exhausted",
            detail: "No free reviewer name or branch remains. Nothing was launched.",
          })
        : Ok({
            name: chosen.name,
            branch: input.reuse?.branch ?? chosen.branch ?? "",
            workspaceId: workspace.workspaceId,
          });
    })
    .map(({ chosen }) => chosen);
}

/**
 * A recorded worktree from a failed start is reopened at the PR head that this start read.
 * A clean worktree on an older head moves to it. A changed one stays, and the start refuses.
 */
function reusable(input: ReviewerLaunch) {
  return fromPromise(
    async () => {
      const path = input.reuse?.path ?? null;
      if (path === null || (await realPathOrNull(path)) === null) return Ok(null);
      if ((await git(path, ["rev-parse", "HEAD"])) === input.head) return Ok(path);
      const status = await git(path, ["status", "--porcelain"]);
      if (status !== "")
        return Err<Failure>({
          reason: "review_worktree_changed",
          detail: `The recorded reviewer worktree ${path} has changes and is not at the PR head ${input.head}. Ask the person what to keep. Nothing was launched.`,
        });
      return (await git(path, ["reset", "--quiet", "--hard", input.head])) === null
        ? Err<Failure>({
            reason: "review_worktree_changed",
            detail: `Git could not move ${path} to the PR head ${input.head}. Nothing was launched.`,
          })
        : Ok(path);
    },
    (cause, defect) => (cause instanceof Error ? qualify(cause, defect) : defect(cause)),
  ).flatMap((result) => result);
}

function place(input: ReviewerLaunch, workspaceId: string, name: string, branch: string) {
  return reusable(input).flatMap((path) =>
    path === null
      ? Herdr.createWorktree({ workspaceId, branch, label: name, base: input.head }).map(
          (created) => ({ ...created, created: true }),
        )
      : Herdr.openWorktree({ workspaceId, path, label: name }).map((opened) => ({
          ...opened,
          path,
          created: false,
        })),
  );
}

/**
 * Starts one reviewer in the PR repository's Herdr workspace, on a local branch at the PR head.
 * It runs with no database transaction open, and the caller records the start and its outcome.
 */
export function launchReviewer(input: ReviewerLaunch) {
  const startedAt = new Date().toISOString();
  return launchSettings(input.paths, input.checkout, input.profile).flatMap((settings) =>
    DoAsync()
      .bind("head", () => fetchHead(input))
      .bind("chosen", () => names(input))
      .bind("snapshot", ({ chosen }) => {
        const { launch, release, skills } = settings;
        return input.record({
          name: chosen.name,
          branch: chosen.branch,
          herdrSocket: settings.herdrSocket,
          launch: JSON.stringify({
            host: launch.host,
            model: launch.model,
            requestedModel: launch.requestedModel,
            reasoningEffort: launch.reasoningEffort,
            profile: launch.profile,
            release,
            skills,
          }),
        });
      })
      .bind("workspaceId", ({ chosen }) =>
        ensureWorkspace(input.checkout, input.repository, chosen.workspaceId),
      )
      .bind("recordedWorkspace", ({ workspaceId }) => input.record({ workspaceId }))
      .bind("placement", ({ workspaceId, chosen }) =>
        place(input, workspaceId, chosen.name, chosen.branch),
      )
      .bind("recordedPlacement", ({ placement }) =>
        input.record({
          tabId: placement.tabId,
          paneId: placement.paneId,
          worktreePath: placement.path,
          worktreeWorkspaceId: placement.workspaceId,
        }),
      )
      .bind("preparation", ({ placement }) =>
        placement.created
          ? waitForPreparation(input.paths, placement.path, startedAt)
          : preparedAgain(input.paths, placement.path),
      )
      .bind("brief", ({ placement, chosen }) =>
        fromPromise(
          async () => {
            await Bun.write(
              input.brief.file,
              input.brief.render({ worktree: placement.path, branch: chosen.branch }),
              {
                createPath: true,
              },
            );
            return input.brief.file;
          },
          (cause, defect) => (cause instanceof Error ? qualify(cause, defect) : defect(cause)),
        ),
      )
      .bind("agent", ({ chosen, placement }) =>
        Herdr.startAgent({
          name: chosen.name,
          kind: settings.launch.host === "claude-code" ? "claude" : "opencode",
          paneId: placement.paneId,
          args: settings.launch.command.args,
        }),
      )
      .bind("prompted", ({ chosen, brief }) =>
        Herdr.prompt({ name: chosen.name, text: `Read ${brief} and follow it.` }),
      )
      .map(({ chosen, placement, preparation, brief }) => ({
        name: chosen.name,
        branch: chosen.branch,
        host: settings.launch.host,
        model: settings.launch.model,
        reasoningEffort: settings.launch.reasoningEffort,
        profile: settings.launch.profile,
        paneId: placement.paneId,
        worktreePath: placement.path,
        preparation,
        brief,
      })),
  );
}

/**
 * Moves the reviewer worktree from the head that the reviewer had to the new PR head. A clean
 * worktree on either head moves. A fast-forward keeps the reviewer's context on the new commits,
 * and a force push resets the worktree, so the reviewer reviews the PR again from the start.
 */
export function moveReviewer(input: {
  checkout: string;
  repository: string;
  number: number;
  worktree: string;
  from: string;
  to: string;
}) {
  return Projects.githubRemote({ checkout: input.checkout, repository: input.repository }).flatMap(
    (remote) =>
      fromPromise(
        async () => {
          if (remote === null)
            return Err<Failure>({
              reason: "review_fetch_failed",
              detail: `The controlling checkout has no remote for ${input.repository}.`,
            });
          const ref = `refs/remotes/${remote}/pr/${input.number}`;
          const fetched = await git(input.checkout, [
            "fetch",
            "--no-tags",
            "--quiet",
            remote,
            `+refs/pull/${input.number}/head:${ref}`,
          ]);
          // A later move needs the fetched commit. The next wait reports any further move.
          if (
            fetched === null ||
            (await git(input.checkout, ["cat-file", "-e", `${input.to}^{commit}`])) === null
          )
            return Err<Failure>({
              reason: "review_fetch_failed",
              detail: `Git could not fetch ${input.to} of PR #${input.number} from ${remote}.`,
            });
          const path = await realPathOrNull(input.worktree);
          const at = path === null ? null : await git(path, ["rev-parse", "HEAD"]);
          const status = path === null ? null : await git(path, ["status", "--porcelain"]);
          if (path === null || (at !== input.from && at !== input.to) || status !== "")
            return Err<Failure>({
              reason: "review_worktree_changed",
              detail: `The reviewer worktree ${input.worktree} is missing, changed, or not at ${input.from}. Ask the person what to keep.`,
            });
          const ancestor =
            (await git(path, ["merge-base", "--is-ancestor", input.from, input.to])) !== null;
          const mode = ancestor ? ("fast-forward" as const) : ("force-push" as const);
          if (at === input.to) return Ok({ mode });
          const moved = ancestor
            ? await git(path, ["merge", "--ff-only", "--quiet", input.to])
            : await git(path, ["reset", "--quiet", "--hard", input.to]);
          return moved === null
            ? Err<Failure>({
                reason: "review_worktree_changed",
                detail: `Git could not move ${path} to ${input.to}.`,
              })
            : Ok({ mode });
        },
        (cause, defect) => (cause instanceof Error ? qualify(cause, defect) : defect(cause)),
      ).flatMap((result) => result),
  );
}
