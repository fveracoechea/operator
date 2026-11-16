import { ErrAsync, fromPromise, type AsyncResult } from "unthrown";
import type { ResultContext } from "../../lib/cli-result.ts";
import { DeviceState } from "../device-state/main.ts";
import { Environment } from "../environment/main.ts";
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
import { owned, reviewEnded, worktreeFacts } from "./internal-review.ts";

type Request = { paths: Paths; cwd: string; sourceId?: string; assignment?: string };
type Failure = { reason: string; detail: string } & ResultContext;
type Outcome = { reason: string; data: object };
type Delivery = Extract<ReturnType<typeof DeviceState.claimDelivery>, { tag: "Ok" }>["value"];

// A built release runs `cli.js`, and a source install runs `cli.ts`.
const packageRoot = new URL("../../", import.meta.url);

async function entryPoint() {
  // Stryker disable next-line StringLiteral: no rule: only a built release has cli.js, and a source test cannot add one to the shared package root
  const built = Bun.fileURLToPath(new URL("cli.js", packageRoot));
  return (await Bun.file(built).exists())
    ? built
    : Bun.fileURLToPath(new URL("cli.ts", packageRoot));
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
  changed: boolean,
): AsyncResult<Outcome, Failure> {
  return DeviceState.readDelivery(input.paths, owner.launchId)
    .toAsync()
    .flatMap((outstanding) => {
      if (outstanding === null) return eligible(input, owner, number, observed, local, changed);
      return claimed(
        input,
        owner,
        outstanding.head,
        true,
        (delivery) => {
          if (observed.state === "MERGED") return verify(input, owner, number, delivery.head, null);
          if (delivery.requestUuid === null)
            return ErrAsync<Failure>({
              reason: "pr_delivery_running",
              detail:
                "The earlier delivery has an unknown outcome and no request identity. An OPEN PR does not prove it stopped. No new merge was requested.",
              next: {
                decider: "super-agent",
                question:
                  "How can the earlier delivery's terminal outcome be established without submitting another merge?",
              },
            });
          const uuid = delivery.requestUuid;
          return fromPromise(async () => {
            const refused = await requestMerge(
              input,
              { ...owner, launchId: delivery.launchId },
              number,
              { head: delivery.head, method: observed.mergeMethod },
              uuid,
            );
            return await verify(input, owner, number, delivery.head, refused);
          }, qualify).flatMap((answer) => answer);
        },
        outstanding.id,
      );
    });
}

function eligible(
  input: Request,
  owner: Owner,
  number: number,
  observed: Observation,
  local: string | null,
  changed: boolean,
) {
  const relay = owner.relay === null ? null : relaySchema.parse(JSON.parse(owner.relay));
  const decision = decideMerge({
    observed,
    localHead: local,
    stackRelayed: relay === null || relay.state === "relayed",
    reviewEnded: reviewEnded(owner),
  });
  if (decision.result === "refused")
    return ErrAsync<Failure>({ reason: decision.reason, detail: decision.detail });
  if (decision.result === "verify")
    return claimed(input, owner, observed.head, true, () =>
      verify(input, owner, number, observed.head, null),
    );
  if (changed)
    return ErrAsync<Failure>({
      reason: "pr_worktree_unclean",
      detail:
        "Commit and push changed and untracked work before delivery. Nothing was merged or removed.",
      next: {
        command: "operator pr wait --json",
        why: "The owner must commit and push its changes before delivery.",
      },
    });
  return claimed(input, owner, decision.head, false, () =>
    worktreeFacts(owner.worktreePath).flatMap((facts) => {
      if (facts.changed || facts.localHead !== decision.head) {
        const released = DeviceState.finishDelivery(input.paths, owner.launchId, decision.head);
        if (released.tag !== "Ok")
          return ErrAsync<Failure>({
            reason: "pr_defect",
            detail: "Could not settle the prewrite refusal.",
          });
        return ErrAsync<Failure>({
          reason: "pr_worktree_unclean",
          detail:
            "The worktree changed during delivery. Reconcile it before retrying. Nothing was merged or removed.",
          next: {
            decider: "super-agent",
            question: "How should the owner reconcile the worktree that changed during delivery?",
          },
        });
      }
      return fromPromise(async () => {
        const refused = await requestMerge(input, owner, number, decision);
        return await verify(input, owner, number, decision.head, refused);
      }, qualify).flatMap((answer) => answer);
    }),
  );
}

function claimed(
  input: Request,
  owner: Owner,
  head: string,
  reconcile: boolean,
  action: (delivery: Delivery) => AsyncResult<Outcome, Failure>,
  resumeId?: string,
) {
  return DeviceState.claimDelivery(input.paths, {
    launchId: owner.launchId,
    head,
    session: Environment.caller().session,
    selected: input.sourceId !== undefined,
    reconcile,
    resumeId,
  })
    .toAsync()
    .flatMap((delivery) =>
      fromPromise(async () => {
        const stop = DeviceState.holdDelivery(input.paths, delivery.launchId);
        try {
          return await action(delivery);
        } finally {
          stop();
          DeviceState.suspendDelivery(input.paths, delivery.launchId);
        }
      }, qualify).flatMap((result) => result),
    );
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
  input: Request,
  owner: Owner,
  number: number,
  merge: { head: string; method: Observation["mergeMethod"] },
  uuid?: string,
): Promise<Failure | null> {
  const repository = owner.repository;
  let answer: Answer =
    uuid === undefined
      ? await mergePullRequest(repository, { number, ...merge })
      : await readMergeRequest(repository, number, uuid);
  for (let reads = 0; ; reads += 1) {
    if (answer.tag !== "Ok") {
      return requestRefusal(input, owner, merge.head, answer, uuid !== undefined || reads > 0);
    }
    if (answer.value.uuid !== null) {
      const saved = DeviceState.recordDeliveryRequest(
        input.paths,
        owner.launchId,
        answer.value.uuid,
      );
      if (saved.tag !== "Ok")
        return {
          reason: "pr_merge_unverified",
          detail:
            "The accepted request identity could not be saved. The delivery remains outstanding.",
        };
    }
    if (answer.value.status === "failed") {
      const released = DeviceState.finishDelivery(input.paths, owner.launchId, merge.head);
      if (released.tag !== "Ok")
        return { reason: "pr_defect", detail: "Could not settle the failed delivery." };
    }
    const next = followMergeRequest(answer.value, reads);
    if (next.result === "verify") return next.refusal;
    await Bun.sleep(mergeRequestReadMs);
    answer = await readMergeRequest(repository, number, next.uuid);
  }
}

function requestRefusal(
  input: Request,
  owner: Owner,
  head: string,
  answer: Exclude<Answer, { tag: "Ok" }>,
  read: boolean,
): Failure {
  if (!read && answer.tag === "Err" && answer.error.reason === "github_failed") {
    const released = DeviceState.finishDelivery(input.paths, owner.launchId, head);
    if (released.tag !== "Ok")
      return { reason: "pr_defect", detail: "Could not settle the refused delivery." };
  }
  return refusal(answer, read);
}

/**
 * The owner's guarded merge. A fresh GitHub observation must show approval, passing checks,
 * no unresolved thread, and the default branch as base, any internal review must have ended
 * ready or skipped, and the owner's worktree must hold the PR head. A refusal performs no merge
 * request and writes nothing.
 */
export function merge(input: Request) {
  return resolveOwner(input)
    .flatMap(owned)
    .flatMap((owner): AsyncResult<Outcome, Failure> => {
      const number = owner.pullRequest;
      if (number === null)
        return ErrAsync<Failure>({
          reason: "pr_not_associated",
          detail: "Run operator pr associate after you open the PR. Nothing was merged or changed.",
        });
      return observePullRequest(owner.repository, number).flatMap((observed) =>
        worktreeFacts(owner.worktreePath).flatMap(({ localHead, changed }) =>
          guarded(input, owner, number, observed, localHead, changed),
        ),
      );
    });
}
