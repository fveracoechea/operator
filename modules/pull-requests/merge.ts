import { ErrAsync, fromPromise, type AsyncResult } from "unthrown";
import { DeviceState } from "../device-state/main.ts";
import { ToolInvocation } from "../tool-invocation/main.ts";
import { WorkSources } from "../work-sources/main.ts";
import { mergePullRequest, observePullRequest, type Observation } from "./github.ts";
import { decideMerge, verifiedMerge } from "./merge-machine.ts";
import { relaySchema } from "./relay.ts";
import { qualify, resolveOwner, type Owner, type Paths } from "./owner.ts";

type Request = { paths: Paths; cwd: string };
type Failure = { reason: string; detail: string };
type Outcome = { reason: string; data: object };

// A built release runs `cli.js`, and a source install runs `cli.ts`.
const packageRoot = new URL("../../", import.meta.url);

async function entryPoint() {
  const built = Bun.fileURLToPath(new URL("cli.js", packageRoot));
  return (await Bun.file(built).exists())
    ? built
    : Bun.fileURLToPath(new URL("cli.ts", packageRoot));
}

async function localHead(worktree: string) {
  const result = await ToolInvocation.run({
    tool: "git",
    args: ["-C", worktree, "rev-parse", "--verify", "HEAD"],
    timeoutMs: 10000,
  });
  return result.status === "completed" && result.exitCode === 0 ? result.stdout.trim() : null;
}

/**
 * The owner's pane closes during cleanup, which ends this process, so cleanup runs in its own
 * process group from the controlling checkout. A start that fails stays visible as stopped.
 */
function startCleanup(paths: Paths, owner: Owner) {
  return fromPromise(
    async () =>
      ToolInvocation.detach({
        tool: process.execPath,
        args: [
          await entryPoint(),
          "cleanup",
          "--source",
          owner.sourceId,
          "--assignment",
          owner.assignment,
          "--json",
        ],
        cwd: owner.checkout,
      }),
    (cause, defect) => (cause instanceof Error ? qualify(cause, defect) : defect(cause)),
  )
    .flatMap((pid) => DeviceState.startCleanup(paths, owner.sourceId, owner.assignment, pid))
    .map(() => "started");
}

function record(
  input: Request,
  owner: Owner,
  number: number,
  merged: { head: string; mergeCommit: string },
) {
  return DeviceState.recordPullRequestMerge(
    input.paths,
    owner.launchId,
    { number, head: merged.head, mergeCommit: merged.mergeCommit },
    (rows) => WorkSources.stateAfter(rows),
  )
    .toAsync()
    .flatMap(({ changed }) =>
      startCleanup(input.paths, owner).map((cleanup) => ({
        reason: changed ? "pr_merged" : "pr_merge_unchanged",
        data: {
          sourceId: owner.sourceId,
          assignment: owner.assignment,
          branch: owner.branch,
          number,
          head: merged.head,
          mergeCommit: merged.mergeCommit,
          state: "merged",
          cleanup,
        },
      })),
    );
}

/** Reads the PR again after the merge request, because only GitHub's state proves the merge. */
function verify(
  input: Request,
  owner: Owner,
  number: number,
  head: string | null,
  request: Failure | null,
): AsyncResult<Outcome, Failure> {
  return observePullRequest(owner.repository, number).flatMap((observed) => {
    const merged = verifiedMerge(observed, head);
    if (merged !== null) return record(input, owner, number, merged);
    return ErrAsync<Failure>(
      request ?? {
        reason: "pr_merge_unverified",
        detail: `GitHub does not report PR #${number} merged at ${head ?? observed.head}. Nothing was recorded. Repeat operator pr merge.`,
      },
    );
  });
}

function guarded(
  input: Request,
  owner: Owner,
  number: number,
  observed: Observation,
  local: string | null,
) {
  const relay = owner.relay === null ? null : relaySchema.parse(JSON.parse(owner.relay));
  const decision = decideMerge({
    observed,
    localHead: local,
    stackRelayed: relay === null || relay.state === "relayed",
  });
  if (decision.result === "refused")
    return ErrAsync<Failure>({ reason: decision.reason, detail: decision.detail });
  if (decision.result === "verify") return verify(input, owner, number, null, null);
  // A refused or lost answer can follow a merge that landed, so every answer is verified.
  return fromPromise(
    async () => {
      const answer = await mergePullRequest(owner.repository, {
        number,
        head: decision.head,
        method: decision.method,
      });
      const refused =
        answer.tag === "Ok"
          ? null
          : answer.tag === "Err"
            ? {
                reason:
                  answer.error.reason === "github_failed"
                    ? "pr_merge_refused"
                    : answer.error.reason,
                detail: answer.error.detail,
              }
            : { reason: "pr_defect", detail: String(answer.cause) };
      return await verify(input, owner, number, decision.head, refused);
    },
    (cause, defect) => (cause instanceof Error ? qualify(cause, defect) : defect(cause)),
  ).flatMap((result) => result);
}

/**
 * The owner's guarded merge. A fresh GitHub observation must show approval, passing checks,
 * no unresolved thread, and the default branch as base, and the owner's worktree must hold the
 * PR head. A refusal performs no merge request and writes nothing.
 */
export function merge(input: Request) {
  return resolveOwner(input).flatMap((owner): AsyncResult<Outcome, Failure> => {
    const number = owner.pullRequest;
    if (number === null)
      return ErrAsync<Failure>({
        reason: "pr_not_associated",
        detail: "Run operator pr associate after you open the PR. Nothing was merged or changed.",
      });
    return observePullRequest(owner.repository, number).flatMap((observed) =>
      fromPromise(
        () => localHead(owner.worktreePath ?? ""),
        (cause, defect) => (cause instanceof Error ? qualify(cause, defect) : defect(cause)),
      ).flatMap((local) => guarded(input, owner, number, observed, local)),
    );
  });
}
