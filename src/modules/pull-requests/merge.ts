import { ErrAsync, OkAsync, fromPromise, type AsyncResult } from "unthrown";
import { DeviceState } from "../device-state/main.ts";
import { ToolInvocation } from "../tool-invocation/main.ts";
import { WorkSources } from "../work-sources/main.ts";
import { WorkerKinds } from "../worker-kinds/main.ts";
import {
  mergePullRequest,
  observePullRequest,
  readMergeRequest,
  readMergeQueue,
  enqueuePullRequest,
  type Observation,
} from "./github.ts";
import {
  decideMerge,
  followMergeRequest,
  mergeRequestReadMs,
  verifiedMerge,
} from "./merge-machine.ts";
import { relaySchema } from "./relay.ts";
import { qualify, resolveOwner, resolveParkedOwner, type Owner, type Paths } from "./owner.ts";
import { owned, reviewEnded } from "./internal-review.ts";
import { parkQuietWait } from "./parking.ts";
import type { Refusal, ResultContext } from "../../lib/cli-result.ts";

type Request = { paths: Paths; cwd: string } & (
  | { sourceId: string; assignment: string }
  | { sourceId?: never; assignment?: never }
);
type Failure = Refusal;
type Outcome = { reason: string; data: object } & Partial<ResultContext>;

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
  if (input.sourceId !== undefined && request?.next.command === "operator pr merge")
    request = { ...request, next: { ...request.next, command: mergeCommand(input) } };
  return observePullRequest(owner.repository, number).flatMap((observed) => {
    const merged = verifiedMerge(observed, head);
    if (merged !== null) return record(input, owner, number, merged);
    return ErrAsync<Failure>(
      request ?? {
        reason: "pr_merge_unverified",
        detail: `GitHub does not report PR #${number} merged at ${head ?? observed.head}. Nothing was recorded. Repeat operator pr merge.`,
        next: {
          command: mergeCommand(input),
          why: "Verify whether the earlier merge request landed.",
        },
        state: {
          pullRequest: number,
          expectedHead: head,
          observedState: observed.state,
          observedHead: observed.head,
        },
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
  if (
    owner.parkedHead !== undefined &&
    (observed.head !== owner.parkedHead || local !== owner.parkedHead)
  )
    return ErrAsync<Failure>({
      reason: "pr_head_mismatch",
      detail: "The parked head changed. Nothing was merged, enqueued, or recorded.",
      next: {
        decider: "super-agent",
        question: "How should the parked head be reconciled without losing work?",
      },
      state: { expectedHead: owner.parkedHead, observedHead: observed.head, localHead: local },
    });
  const queueHead =
    owner.parking === null
      ? null
      : (DeviceState.prParkingSchema().parse(JSON.parse(owner.parking)).queueHead ?? null);
  const relay = owner.relay === null ? null : relaySchema.parse(JSON.parse(owner.relay));
  const decision = decideMerge({
    observed,
    localHead: local,
    stackRelayed: relay === null || relay.state === "relayed",
    reviewEnded: reviewEnded(owner),
  });
  if (decision.result === "refused")
    return ErrAsync<Failure>(
      input.sourceId !== undefined && decision.reason === "pr_merge_blocked"
        ? {
            ...decision,
            next: {
              command: `operator next --source ${input.sourceId} --wait`,
              why: "The parked assignment needs a changed observation before merge can pass.",
            },
          }
        : decision,
    );
  if (decision.result === "verify") {
    if (queueHead !== null) return awaitBatch(input, owner, number, observed);
    if (input.sourceId === undefined) return verify(input, owner, number, null, null);
    return readMergeQueue(owner.repository, number).flatMap(
      (queue): AsyncResult<Outcome, Failure> =>
        queue.enabled
          ? OkAsync({
              reason: "pr_merge_awaiting_batch",
              data: {
                sourceId: owner.sourceId,
                assignment: owner.assignment,
                number,
                head: observed.head,
                state: "pr-open",
              },
              next: {
                command: `operator next --source ${owner.sourceId} --wait`,
                why: "Only the parked batch records the queued merge and starts cleanup.",
              },
            })
          : verify(input, owner, number, null, null),
    );
  }
  return fromPromise(() => mergePhase(owner), qualify).flatMap(
    (phase): AsyncResult<Outcome, Failure> => {
      if (phase !== null) return ErrAsync(phase);
      return readMergeQueue(owner.repository, number).flatMap(
        (queue): AsyncResult<Outcome, Failure> => {
          if (queue.enabled || queue.entry !== null)
            return queuedMerge(input, owner, number, observed, decision.head, queue);
          if (queueHead !== null) return awaitBatch(input, owner, number, observed);
          // A refused or lost answer can follow a merge that landed, so every answer is verified.
          return fromPromise(
            () => requestMerge(owner.repository, number, decision),
            qualify,
          ).flatMap((refused) => verify(input, owner, number, decision.head, refused));
        },
      );
    },
  );
}

type Queue = Extract<Awaited<ReturnType<typeof readMergeQueue>>, { tag: "Ok" }>["value"];

function awaitBatch(
  input: Request,
  owner: Owner,
  number: number,
  observed: Observation,
): AsyncResult<Outcome, Failure> {
  const parked =
    owner.launchState === "running" ? parkQuietWait(input, owner, observed) : OkAsync(true);
  return parked.map(() => ({
    reason: "pr_merge_awaiting_batch",
    data: {
      sourceId: owner.sourceId,
      assignment: owner.assignment,
      number,
      head: observed.head,
      state: "pr-open",
    },
    next: {
      command: `operator next --source ${owner.sourceId} --wait`,
      why: "Only the parked batch records the queued merge and starts cleanup.",
    },
  }));
}

function queuedMerge(
  input: Request,
  owner: Owner,
  number: number,
  observed: Observation,
  head: string,
  queue: Queue,
): AsyncResult<Outcome, Failure> {
  if (queue.head !== head || queue.state !== "OPEN")
    return ErrAsync({
      reason: "pr_head_mismatch",
      detail: "The PR changed after the merge gate. Nothing was enqueued.",
      next: { command: mergeCommand(input), why: "Repeat the fresh merge gate before enqueueing." },
      state: { expectedHead: head, observedHead: queue.head, observedState: queue.state },
    });
  return DeviceState.recordPullRequestQueue(input.paths, owner.launchId, head)
    .toAsync()
    .flatMap(() =>
      fromPromise(async () => {
        const requested = queue.entry === null ? await enqueuePullRequest(queue.id, head) : null;
        const verification = await readMergeQueue(owner.repository, number);
        if (requested?.tag === "Defect") {
          if (verification.tag !== "Ok")
            console.error("enqueue_verification", { secondary: verification });
          return requested.map<Outcome>(() => enqueued(owner, number, head, null));
        }
        return verification.toAsync().flatMap((confirmed): AsyncResult<Outcome, Failure> => {
          // A lost answer can follow an accepted enqueue; membership, not the answer, proves it.
          if (confirmed.entry === null || confirmed.head !== head) {
            if (requested !== null && requested.tag !== "Ok")
              return requested.map(() => enqueued(owner, number, head, confirmed.entry)).toAsync();
            return ErrAsync({
              reason: "pr_enqueue_unverified",
              detail:
                "GitHub did not confirm queue membership for the guarded head. The assignment remains open.",
              next: {
                command: mergeCommand(input),
                why: "Read queue membership and the merge gate before retrying.",
              },
              state: { expectedHead: head, queued: confirmed.entry !== null },
            });
          }
          return owner.launchState === "running"
            ? parkQuietWait(input, owner, observed).map(() =>
                enqueued(owner, number, head, confirmed.entry),
              )
            : OkAsync(enqueued(owner, number, head, confirmed.entry));
        });
      }, qualify).flatMap((result) => result),
    );
}

function enqueued(owner: Owner, number: number, head: string, entry: string | null) {
  return {
    reason: "pr_enqueued",
    data: {
      sourceId: owner.sourceId,
      assignment: owner.assignment,
      number,
      head,
      state: "pr-open",
      queueEntry: entry,
    },
    next: {
      command: `operator next --source ${owner.sourceId} --wait`,
      why: "The parked assignment completes only when a batch read verifies the merge.",
    },
  };
}

function mergeCommand(input: Request) {
  return input.sourceId === undefined
    ? "operator pr merge"
    : `operator pr merge --source ${input.sourceId} --assignment ${input.assignment}`;
}

/** Earlier readiness is a phase witness, not a substitute for the fresh merge decision. */
async function mergePhase(owner: Owner): Promise<Failure | null> {
  if (owner.kind === null) return null;
  const ready = reviewEnded(owner);
  const status = await ToolInvocation.run({
    tool: "git",
    args: ["status", "--porcelain", "--untracked-files=normal"],
    cwd: owner.worktreePath,
    timeoutMs: 10000,
  });
  const phase = WorkerKinds.decidePhase(
    {
      kind: WorkerKinds.snapshotSchema().parse(JSON.parse(owner.kind)),
      report: null,
      pr: { associated: true, rounds: 0, ready, merged: false, parked: false },
      internalReview: owner.internalReview === true,
      reviewEnded: reviewEnded(owner),
      worktreeClean: status.status === "completed" && status.exitCode === 0 && status.stdout === "",
    },
    "merge",
  );
  return phase.refusal === undefined
    ? null
    : { ...phase.refusal, next: phase.next, kind: phase.kind, phase: phase.phase };
}

type Answer = Awaited<ReturnType<typeof mergePullRequest>>;

function refusal(answer: Exclude<Answer, { tag: "Ok" }>, read: boolean): Failure {
  if (answer.tag === "Defect")
    return {
      reason: "pr_defect",
      detail: String(answer.cause),
      next: {
        decider: "super-agent",
        question: "How should the unexpected merge failure be investigated before another request?",
      },
    };
  if (answer.error.reason !== "github_failed") return answer.error;
  // GitHub accepted the request before a read failed, so the merge can still land.
  return read
    ? {
        ...answer.error,
        reason: "pr_merge_unverified",
        detail: `GitHub did not answer the merge request read: ${answer.error.detail}. Nothing was recorded. Repeat operator pr merge.`,
        next: {
          command: "operator pr merge",
          why: "Verify whether the earlier merge request landed.",
        },
      }
    : {
        ...answer.error,
        reason: "pr_merge_refused",
        detail: answer.error.detail,
        next: {
          decider: "person",
          question: "Which GitHub merge restriction must be resolved before this PR can merge?",
        },
      };
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
 * no unresolved thread, and the default branch as base, any internal review must have ended
 * ready or skipped, and the owner's worktree must hold the PR head. A refusal performs no merge
 * request and writes nothing.
 */
export function merge(input: Request) {
  const owner =
    input.sourceId !== undefined && input.assignment !== undefined
      ? resolveParkedOwner({ ...input, sourceId: input.sourceId, assignment: input.assignment })
      : resolveOwner(input).flatMap(owned);
  return owner
    .flatMap((owner): AsyncResult<Outcome, Failure> => {
      const number = owner.pullRequest;
      if (number === null)
        return ErrAsync<Failure>({
          reason: "pr_not_associated",
          detail: "Run operator pr associate after you open the PR. Nothing was merged or changed.",
          next: {
            command: "operator pr associate",
            why: "Associate the assignment's open PR before merging.",
          },
          state: { pullRequest: null },
        });
      return observePullRequest(owner.repository, number).flatMap((observed) =>
        fromPromise(() => localHead(owner.worktreePath), qualify).flatMap((local) =>
          guarded(input, owner, number, observed, local),
        ),
      );
    })
    .map((outcome) =>
      input.sourceId === undefined || outcome.next !== undefined
        ? outcome
        : {
            ...outcome,
            next: {
              command: `operator next --source ${input.sourceId}`,
              why: "Read the assignment's completion and cleanup state.",
            },
          },
    );
}
