import { ErrAsync, fromPromise, type AsyncResult } from "unthrown";
import { DeviceState } from "../device-state/main.ts";
import { ToolInvocation } from "../tool-invocation/main.ts";
import { WorkSources } from "../work-sources/main.ts";
import {
  mergePullRequest,
  observePullRequest,
  readMergeRequest,
  type Observation,
} from "./github.ts";
import {
  decideMerge,
  followMergeRequest,
  mergeRequestReadMs,
  verifiedMerge,
} from "./merge-machine.ts";
import { relaySchema } from "./relay.ts";
import { qualify, resolveOwner, type Owner, type Paths } from "./owner.ts";

type Request = { paths: Paths; cwd: string };
type Failure = { reason: string; detail: string };
type Outcome = { reason: string; data: object };

// A built release runs `cli.js`, and a source install runs `cli.ts`.
const packageRoot = new URL("../../", import.meta.url);

async function entryPoint() {
  // Stryker disable next-line StringLiteral: no rule: only a built release has cli.js, and a source test cannot add one to the shared package root
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
  // Stryker disable next-line ConditionalExpression: equivalent: a result that did not complete has no exit code, so the exit code check alone returns null
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
    qualify,
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
  return fromPromise(async () => {
    const refused = await requestMerge(owner.repository, number, decision);
    return await verify(input, owner, number, decision.head, refused);
  }, qualify).flatMap((result) => result);
}

type Answer = Awaited<ReturnType<typeof mergePullRequest>>;

function refusal(answer: Exclude<Answer, { tag: "Ok" }>, read: boolean) {
  if (answer.tag === "Defect") return { reason: "pr_defect", detail: String(answer.cause) };
  if (answer.error.reason !== "github_failed")
    return { reason: answer.error.reason, detail: answer.error.detail };
  // GitHub accepted the request before a read failed, so the merge can still land.
  return read
    ? {
        reason: "pr_merge_unverified",
        detail: `GitHub did not answer the merge request read: ${answer.error.detail}. Nothing was recorded. Repeat operator pr merge.`,
      }
    : { reason: "pr_merge_refused", detail: answer.error.detail };
}

/**
 * Submits the merge and reads the background request until it ends. It returns the refusal to
 * report when GitHub does not show the merge, or null when the request reports it merged.
 */
async function requestMerge(
  repository: string,
  number: number,
  merge: { head: string; method: Observation["mergeMethod"] },
): Promise<Failure | null> {
  let answer: Answer = await mergePullRequest(repository, { number, ...merge });
  for (let reads = 0; ; reads += 1) {
    if (answer.tag !== "Ok") return refusal(answer, reads > 0);
    const next = followMergeRequest(answer.value, reads);
    if (next.result === "verify") return next.refusal;
    await Bun.sleep(mergeRequestReadMs);
    answer = await readMergeRequest(repository, number, next.uuid);
  }
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
      fromPromise(() => localHead(owner.worktreePath), qualify).flatMap((local) =>
        guarded(input, owner, number, observed, local),
      ),
    );
  });
}
