import {
  Err,
  ErrAsync,
  Ok,
  OkAsync,
  P,
  fromPromise,
  type AsyncResult,
  type Result,
} from "unthrown";
import { DeviceState } from "../device-state/main.ts";
import { ToolInvocation } from "../tool-invocation/main.ts";
import { WorkSources } from "../work-sources/main.ts";
import { WorkerKinds } from "../worker-kinds/main.ts";
import { Environment } from "../environment/main.ts";
import { directDelivery } from "./direct-delivery.ts";
import {
  observePullRequest,
  readMergeQueue,
  enqueuePullRequest,
  type Observation,
} from "./github.ts";
import { decideMerge, verifiedMerge } from "./merge-machine.ts";
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
    return readQueue(input, owner, number, observed.head).flatMap(
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
      return readQueue(input, owner, number, decision.head).flatMap(
        (queue): AsyncResult<Outcome, Failure> => {
          if (queueHead !== null && queue.entry === null)
            return recoverQueueRefusal(input, owner, number, observed, queue);
          if (queue.enabled || queue.entry !== null)
            return queuedMerge(input, owner, number, observed, decision.head, queue);
          if (queueHead !== null) return awaitBatch(input, owner, number, observed);
          // A refused or lost answer can follow a merge that landed, so every answer is verified.
          return DeviceState.admitDelivery(input.paths, {
            launchId: owner.launchId,
            head: decision.head,
            selected: input.sourceId !== undefined,
            session: Environment.caller().session,
          })
            .toAsync()
            .flatMap((delivery): AsyncResult<Outcome, Failure> => {
              if (delivery === null)
                return ErrAsync({
                  reason: "pr_delivery_running",
                  detail: "No direct intent was recorded.",
                  next: { command: mergeCommand(input), why: "Read the delivery state." },
                });
              return directDelivery({
                paths: input.paths,
                owner,
                number,
                delivery,
                method: decision.method,
              }).flatMap((merged) => record(input, owner, number, merged));
            });
        },
      );
    },
  );
}

type Queue = Extract<Awaited<ReturnType<typeof readMergeQueue>>, { tag: "Ok" }>["value"];

/** Membership must invalidate old refusal proof before another read can report absence. */
function rememberMembership(
  input: Request,
  owner: Owner,
  observed: { head: string; state: string; entry: string | null },
  local: string | null,
): Result<Owner, Failure> {
  if (observed.entry === null) return Ok(owner);
  const parking =
    owner.parking === null ? null : DeviceState.prParkingSchema().parse(JSON.parse(owner.parking));
  if (parking?.queueHead === undefined || parking.queueHead === null) {
    if (
      local === null ||
      observed.head !== local ||
      (owner.parkedHead !== undefined && observed.head !== owner.parkedHead)
    )
      return Err({
        reason: "pr_head_mismatch",
        detail:
          "Observed queue membership does not match the retained local head. Nothing was recorded or submitted.",
        next: {
          command: mergeCommand(input),
          why: "Reconcile the current PR head before delivery.",
        },
      });
    return DeviceState.recordPullRequestQueueObservation(
      input.paths,
      owner.launchId,
      local,
      observed,
      {
        selected: input.sourceId !== undefined,
        session: Environment.caller().session,
      },
    ).map((recorded) => ({ ...owner, parking: JSON.stringify(recorded) }));
  }
  return recordQueueObservation(
    input,
    owner,
    parking.queueHead,
    parking.queueAttempt,
    Ok(observed),
  ).map(() => owner);
}

function readQueue(input: Request, owner: Owner, number: number, head: string) {
  return readMergeQueue(owner.repository, number).flatMap((queue) =>
    rememberMembership(input, owner, queue, head)
      .toAsync()
      .map(() => queue),
  );
}

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

function recoverQueueRefusal(
  input: Request,
  owner: Owner,
  number: number,
  observed: Observation,
  queue: Queue,
): AsyncResult<Outcome, Failure> {
  const parking =
    owner.parking === null ? null : DeviceState.prParkingSchema().parse(JSON.parse(owner.parking));
  const proof = parking?.queueRefusal;
  if (
    proof === null ||
    proof === undefined ||
    parking?.queueAttempt !== proof.attempt ||
    parking.queueHead !== proof.head
  )
    return awaitBatch(input, owner, number, observed);
  return DeviceState.refusePullRequestQueue(
    input.paths,
    owner.launchId,
    proof.head,
    proof.attempt,
    queue,
  )
    .toAsync()
    .flatMap((cleared): AsyncResult<Outcome, Failure> =>
      cleared
        ? ErrAsync({
            reason: "pr_enqueue_refused",
            detail: proof.detail,
            next: {
              command: mergeCommand(input),
              why: "The known refused attempt was reconciled. Repeat the fresh merge gate before new admission.",
            },
            state: { notApplied: true },
          })
        : awaitBatch(input, owner, number, observed),
    );
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
  const parking =
    owner.parking === null ? null : DeviceState.prParkingSchema().parse(JSON.parse(owner.parking));
  const persisted = parking?.queueHead === head;
  return (
    persisted
      ? OkAsync(null)
      : DeviceState.recordPullRequestQueue(input.paths, owner.launchId, head, {
          selected: input.sourceId !== undefined,
          session: Environment.caller().session,
        }).toAsync()
  ).flatMap((attempt) => {
    if (attempt === null && queue.entry === null) return awaitBatch(input, owner, number, observed);
    if (queue.entry !== null) {
      const remembered = recordQueueObservation(
        input,
        owner,
        head,
        attempt ?? parking?.queueAttempt,
        Ok(queue),
      );
      if (remembered.tag !== "Ok")
        return remembered.map<Outcome>(() => enqueued(owner, number, head, null)).toAsync();
    }
    return fromPromise(async () => {
      const requested = queue.entry === null ? await enqueuePullRequest(queue.id, head) : null;
      saveQueueRefusal(input, owner, head, attempt, requested);
      const verification = await queueReadback(
        input,
        owner,
        number,
        head,
        attempt ?? parking?.queueAttempt,
        requested,
      );
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
        if (attempt === null && (parking?.queueAttempt ?? null) === null)
          return awaitBatch(input, owner, number, observed);
        return owner.launchState === "running"
          ? parkQuietWait(input, owner, observed).map(() =>
              enqueued(owner, number, head, confirmed.entry),
            )
          : OkAsync(enqueued(owner, number, head, confirmed.entry));
      });
    }, qualify).flatMap((result) => result);
  });
}

type EnqueueAnswer = Awaited<ReturnType<typeof enqueuePullRequest>> | null;

function queueReadback(
  input: Request,
  owner: Owner,
  number: number,
  head: string,
  attempt: string | null | undefined,
  requested: EnqueueAnswer,
): AsyncResult<Queue, Failure> {
  return fromPromise(async () => {
    const verification = await readMergeQueue(owner.repository, number);
    const recorded = recordQueueObservation(input, owner, head, attempt, verification);
    if (requested !== null && requested.tag !== "Ok") {
      if (recorded.tag !== "Ok") reportQueueFailure("enqueue_release", recorded);
      if (verification.tag !== "Ok") reportQueueFailure("enqueue_verification", verification);
      if (
        recorded.tag !== "Ok" ||
        verification.tag !== "Ok" ||
        requested.tag === "Defect" ||
        requested.error.state?.notApplied === true
      )
        return requested.flatMap(() => verification);
    }
    return recorded.flatMap(() => verification);
  }, qualify).flatMap((result) => result);
}

function saveQueueRefusal(
  input: Request,
  owner: Owner,
  head: string,
  attempt: string | null,
  requested: EnqueueAnswer,
) {
  if (attempt === null || requested?.tag !== "Err" || requested.error.state?.notApplied !== true)
    return;
  const saved = DeviceState.recordPullRequestQueueRefusal(
    input.paths,
    owner.launchId,
    head,
    attempt,
    requested.error.detail,
  );
  if (saved.tag !== "Ok") reportQueueFailure("enqueue_refusal_record", saved);
}

function recordQueueObservation(
  input: Request,
  owner: Owner,
  head: string,
  attempt: string | null | undefined,
  verification: Result<{ head: string; state: string; entry: string | null }, Failure>,
): Result<undefined, Failure> {
  if (attempt === null || attempt === undefined || verification.tag !== "Ok") return Ok(undefined);
  return DeviceState.refusePullRequestQueue(
    input.paths,
    owner.launchId,
    head,
    attempt,
    verification.value,
  ).map(() => undefined);
}

function reportQueueFailure<T>(phase: string, secondary: Result<T, Failure>) {
  const outcome =
    secondary.tag === "Defect"
      ? { tag: secondary.tag, cause: secondary.cause }
      : secondary.tag === "Err"
        ? { tag: secondary.tag, error: secondary.error }
        : { tag: secondary.tag };
  process.stderr.write(
    `${phase} ${Bun.inspect({ secondary: outcome }, { colors: false, compact: true, depth: 8 }).replaceAll("\n", "\\n")}; `,
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

function selectedFailure(input: Request, failure: Failure): Failure {
  return input.sourceId !== undefined && failure.next.command === "operator pr merge"
    ? { ...failure, next: { command: mergeCommand(input), why: failure.next.why } }
    : failure;
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

/**
 * The owner's guarded merge. A fresh GitHub observation must show approval, passing checks,
 * no unresolved thread, and the default branch as base, any internal review must have ended
 * ready or skipped, and the owner's worktree must hold the PR head. A refusal performs no merge
 * request and writes nothing.
 */
export function merge(input: Request): AsyncResult<Outcome, Failure> {
  const owner =
    input.sourceId !== undefined && input.assignment !== undefined
      ? resolveParkedOwner({ ...input, sourceId: input.sourceId, assignment: input.assignment })
      : resolveOwner(input).flatMap(owned);
  const result: AsyncResult<Outcome, Failure> = owner
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
      return DeviceState.readDelivery(input.paths, owner.launchId)
        .toAsync()
        .flatMap((pending): AsyncResult<Outcome, Failure> => {
          if (pending !== null)
            return DeviceState.recoverDelivery(
              input.paths,
              {
                launchId: owner.launchId,
                head: owner.parkedHead ?? pending.head,
                selected: input.sourceId !== undefined,
                session: Environment.caller().session,
              },
              pending.id,
            )
              .toAsync()
              .flatMap((delivery) =>
                directDelivery({ paths: input.paths, owner, number, delivery }).flatMap((merged) =>
                  record(input, owner, number, merged),
                ),
              );
          return fromPromise(() => localHead(owner.worktreePath), qualify).flatMap((local) =>
            observePullRequest(owner.repository, number).flatMap((observed) =>
              rememberMembership(
                input,
                owner,
                {
                  head: observed.head,
                  state: observed.state,
                  entry: observed.queueEntry ?? null,
                },
                local,
              )
                .toAsync()
                .flatMap((remembered) => guarded(input, remembered, number, observed, local)),
            ),
          );
        });
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
  return result.mapErrCases((match) =>
    match.with(P._, (failure) => selectedFailure(input, failure)),
  );
}
