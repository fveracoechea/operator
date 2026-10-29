import { Err, ErrAsync, Ok, OkAsync, fromPromise, type AsyncResult, type Result } from "unthrown";
import { DeviceSettings } from "../device-settings/main.ts";
import { DeviceState } from "../device-state/main.ts";
import { WorkSources } from "../work-sources/main.ts";
import {
  observeParent,
  observePullRequest,
  openPullRequests,
  retarget,
  type Observation,
} from "./github.ts";
import { resolveOwner, qualify, type Owner, type Paths } from "./owner.ts";
import {
  decideRelay,
  needsParent,
  relayBranch,
  relaySchema,
  stacked,
  type Blocker,
  type Relay,
} from "./relay.ts";
import { decideWait, mergeConditions, progressSchema } from "./wait-machine.ts";
import { merge } from "./merge.ts";
import { cleanup } from "./cleanup.ts";

type Request = { paths: Paths; cwd: string };
type Failure = { reason: string; detail: string };

// GitHub limits API reads, so a wait observes the PR at most twice a minute.
const pollMs = 30000;

function summary(owner: Owner, pr: { number: number; url: string }) {
  return {
    sourceId: owner.sourceId,
    assignment: owner.assignment,
    branch: owner.branch,
    number: pr.number,
    url: pr.url,
  };
}

/** The PRs of this assignment's dependencies, which are the only permitted stack parents. */
function parents(input: Request, owner: Owner) {
  return WorkSources.show({
    paths: input.paths,
    cwd: owner.checkout,
    sourceId: owner.sourceId,
  }).map((source) => {
    // Stryker disable next-line ArrayDeclaration: equivalent: an entry that is not a PR row has no branch, so it matches no base and lists as none
    if (source === undefined) return [];
    const planned = source.plan.assignments.find((row) => row.key === owner.assignment);
    return source.pullRequests
      .filter((pr) => planned?.dependencies.includes(pr.assignment) === true)
      .map((pr) => ({
        parent: { assignment: pr.assignment, number: pr.number, branch: pr.branch },
        open: pr.mergedAt === null,
      }));
  });
}

/**
 * The PR targets the default branch, or stacks on the branch of a dependency's PR. A
 * source-wide integration branch or any other base is refused. While a dependency's PR is
 * open, its commits would reach the default branch first, so the PR must stack on it.
 */
function stackOf(
  pr: { base: string; defaultBranch: string | null },
  candidates: { parent: Relay["parent"]; open: boolean }[],
): Result<Relay | null, Failure> {
  const open = candidates.filter((candidate) => candidate.open);
  if (pr.base === pr.defaultBranch && open.length > 0)
    return Err({
      reason: "pr_base_invalid",
      detail: `The PR targets ${pr.base}, but the PR of a dependency is open. Target its branch: ${open.map((row) => row.parent.branch).join(", ")}. Nothing was changed.`,
    });
  if (pr.base === pr.defaultBranch) return Ok(null);
  const parent = candidates.find((candidate) => candidate.parent.branch === pr.base)?.parent;
  return parent === undefined
    ? Err({
        reason: "pr_base_invalid",
        detail: `The PR targets ${pr.base}. Target the default branch or the branch of a dependency's PR: ${candidates.map((row) => row.parent.branch).join(", ") || "none"}. Nothing was changed.`,
      })
    : Ok(stacked(parent));
}

/**
 * The owner opens the PR with its own tools and closing keywords. The CLI only records it.
 * When device settings enable assignment reviews, the same write queues a review request.
 */
function associate(input: Request) {
  return resolveOwner(input).flatMap((owner) =>
    openPullRequests(owner.repository, owner.branch).flatMap((found) => {
      const pr = found[0];
      if (pr === undefined || found.length > 1)
        return ErrAsync<Failure>({
          reason: pr === undefined ? "pr_not_found" : "pr_ambiguous",
          detail: `Open exactly one PR from ${owner.branch} in ${owner.repository}, then repeat. Nothing was changed.`,
        });
      return DeviceSettings.show(input.paths).flatMap((settings) =>
        parents(input, owner).flatMap((candidates) =>
          stackOf(pr, candidates).flatMap((relay) =>
            DeviceState.associatePullRequest(
              input.paths,
              owner.launchId,
              {
                number: pr.number,
                url: pr.url,
                branch: owner.branch,
                relay: relay === null ? null : JSON.stringify(relay),
              },
              settings.data.config.review?.assignments === true,
            ).map(({ changed, row }) => ({
              reason: changed ? "pr_associated" : "pr_unchanged",
              data: {
                ...summary(owner, pr),
                state: "pr-open",
                base: pr.base,
                stack: stackSummary(row.relay),
              },
            })),
          ),
        ),
      );
    }),
  );
}

function parseRelay(text: string | null) {
  return text === null ? null : relaySchema.parse(JSON.parse(text));
}

function stackSummary(text: string | null) {
  const relay = parseRelay(text);
  return relay === null
    ? null
    : { parent: relay.parent, relay: relay.state, blocker: relay.blocker };
}

function progress(text: string) {
  return progressSchema.parse(JSON.parse(text));
}

type Outcome = { reason: string; data: object };
type Recorded = { number: number; url: string; relay: string | null };
// Null means that this wait relayed nothing.
type RelayOutcome =
  | null
  | { kind: "blocked"; blocker: Blocker }
  | { kind: "relayed"; relay: Relay; head: string; base: string };

/** Changes the relay record only while this process holds the claim. */
function recordRelay(
  input: Request,
  owner: Owner,
  change: (relay: Relay) => Relay,
  waitState?: string,
) {
  return DeviceState.recordPullRequestWait(input.paths, owner.launchId, (row) => {
    const relay = parseRelay(row.relay);
    if (relay === null || relay.ownerPid !== process.pid) return null;
    return {
      progress: row.progress,
      waitState: waitState ?? row.waitState,
      relay: JSON.stringify(change(relay)),
    };
  });
}

/** One process at a time relays a PR. A gone process or a stale lease frees its claim. */
function claimRelay(input: Request, owner: Owner) {
  return DeviceState.recordPullRequestWait(input.paths, owner.launchId, (row) => {
    const relay = parseRelay(row.relay);
    if (row.relayHeld || relay === null || relay.state === "relayed") return null;
    return {
      progress: row.progress,
      waitState: row.waitState,
      relay: JSON.stringify({ ...relay, ownerPid: process.pid, leaseAt: new Date().toISOString() }),
    };
  }).map((row) => parseRelay(row?.relay ?? null));
}

function runRelay(
  input: Request,
  owner: Owner,
  relay: Relay,
  observed: Observation & { number: number },
  plan: { defaultBranch: string; parentHead: string },
) {
  const worktree = owner.worktreePath;
  // The lease shows that this relay still runs, also through slow Git steps.
  const release = DeviceState.holdPullRequestRelay(input.paths, owner.sourceId, owner.assignment);
  return fromPromise(async () => {
    try {
      return await relayBranch({
        worktree,
        branch: owner.branch,
        head: observed.head,
        base: observed.base,
        defaultBranch: plan.defaultBranch,
        parentHead: plan.parentHead,
        rebasedHead: relay.rebasedHead,
        recordRebase: async (head) => {
          const recorded = recordRelay(input, owner, (current) => ({
            ...current,
            rebasedHead: head,
          }));
          return recorded.tag === "Ok" && recorded.value !== null;
        },
        retarget: async () => {
          const changed = await retarget(owner.repository, observed.number, plan.defaultBranch);
          return changed.tag === "Ok" ? changed.value : "The base change stopped with a defect.";
        },
      });
    } finally {
      release();
    }
  }, qualify).flatMap((result) => {
    const done: (current: Relay) => Relay =
      "blocker" in result
        ? (current) => ({
            ...current,
            state: "blocked",
            blocker: result.blocker,
            ownerPid: null,
            leaseAt: null,
          })
        : (current) => ({
            ...current,
            state: "relayed",
            blocker: null,
            ownerPid: null,
            leaseAt: null,
          });
    return recordRelay(input, owner, done, "reported").map((row): RelayOutcome => {
      const recorded = parseRelay(row?.relay ?? null);
      if ("blocker" in result) return { kind: "blocked", blocker: result.blocker };
      return recorded === null
        ? null
        : { kind: "relayed", relay: recorded, head: result.head, base: plan.defaultBranch };
    });
  });
}

/**
 * A stacked PR needs its parent's state. After the parent merges into the default branch, this
 * wait relays the PR. Another live relay of the same PR leaves this wait to observe only.
 */
function relayStep(
  input: Request,
  owner: Owner,
  pr: Recorded,
  observed: Observation,
): AsyncResult<RelayOutcome, Failure> {
  const relay = parseRelay(pr.relay);
  if (!needsParent(relay, observed)) return OkAsync(null);
  return observeParent(owner.repository, relay.parent.number).flatMap((parent) => {
    const decision = decideRelay(relay, observed, parent);
    if (decision.action === "none") return OkAsync<RelayOutcome>(null);
    return claimRelay(input, owner)
      .toAsync()
      .flatMap((claimed): AsyncResult<RelayOutcome, Failure> => {
        if (claimed === null) return OkAsync(null);
        if (decision.action === "blocked")
          return recordRelay(
            input,
            owner,
            (current) => ({
              ...current,
              state: "blocked",
              blocker: decision.blocker,
              ownerPid: null,
              leaseAt: null,
            }),
            "reported",
          )
            .toAsync()
            .map(() => ({ kind: "blocked", blocker: decision.blocker }));
        return runRelay(
          input,
          owner,
          claimed,
          { ...observed, number: pr.number },
          {
            defaultBranch: decision.defaultBranch,
            parentHead: parent.head,
          },
        );
      });
  });
}

/** Observes once, records any result, and polls again until the deadline. */
function poll(
  input: Request,
  owner: Owner,
  pr: Recorded,
  deadline: number,
): AsyncResult<Outcome, Failure> {
  return observePullRequest(owner.repository, pr.number).flatMap((observed) =>
    relayStep(input, owner, pr, observed).flatMap((relayed): AsyncResult<Outcome, Failure> => {
      if (relayed?.kind === "blocked") return ErrAsync(relayed.blocker);
      if (relayed?.kind === "relayed")
        return OkAsync({
          reason: "pr_events_observed",
          data: {
            ...summary(owner, pr),
            head: relayed.head,
            // The relay pushed a new head on a new base, so no check has reported for it yet,
            // and the relay counts from the next wait.
            mergeConditions: mergeConditions(
              { ...observed, base: relayed.base, checks: [] },
              false,
            ),
            events: [
              {
                kind: "parent_relayed",
                parent: relayed.relay.parent,
                base: relayed.base,
                head: relayed.head,
              },
            ],
          },
        });
      return decideOnce(input, owner, pr, observed, deadline);
    }),
  );
}

function decideOnce(
  input: Request,
  owner: Owner,
  pr: Recorded,
  observed: Observation,
  deadline: number,
): AsyncResult<Outcome, Failure> {
  {
    // A stacked PR is not eligible before its relay. A relay by another wait counts from the next wait.
    const relay = parseRelay(pr.relay);
    const stackRelayed = relay === null || relay.state === "relayed";
    // The decision runs inside the write transaction on the progress that it reads there.
    // Stryker disable next-line ObjectLiteral,StringLiteral: equivalent: a successful write always runs the decision, which replaces this start value before it is read
    const outcome: { decision: ReturnType<typeof decideWait> } = { decision: { result: "none" } };
    const data = {
      ...summary(owner, pr),
      head: observed.head,
      mergeConditions: mergeConditions(observed, stackRelayed),
    };
    return DeviceState.recordPullRequestWait(input.paths, owner.launchId, (row) => {
      const decision = decideWait({ progress: progress(row.progress), observed, stackRelayed });
      outcome.decision = decision;
      return decision.result === "none"
        ? null
        : { progress: JSON.stringify(decision.progress), waitState: decision.result };
    })
      .toAsync()
      .flatMap((): AsyncResult<Outcome, Failure> => {
        const reported = outcome.decision;
        if (reported.result !== "none")
          return OkAsync({
            reason: reported.result === "not_open" ? "pr_not_open" : "pr_events_observed",
            data: { ...data, events: reported.events },
          });
        // Stryker disable next-line EqualityOperator: no rule: Operator promises no result for a read that ends in the same millisecond as the deadline
        if (Date.now() >= deadline)
          return DeviceState.recordPullRequestWait(input.paths, owner.launchId, (row) => ({
            progress: row.progress,
            waitState: "timed_out",
          }))
            .toAsync()
            .map(() => ({ reason: "pr_wait_timed_out", data: { ...data, events: [] } }));
        return fromPromise(
          () => Bun.sleep(Math.min(pollMs, deadline - Date.now())),
          qualify,
        ).flatMap(() => poll(input, owner, pr, deadline));
      });
  }
}

/**
 * Observes the owner's PR until it reports an applicable event or the timeout passes. Each
 * result is recorded before it is returned, so a restarted wait continues from device state.
 * The recorded start clears an earlier timeout, so the SuperAgent sees a timeout only while
 * the owner does not wait again.
 */
function wait(input: Request & { timeoutSeconds: number }) {
  return resolveOwner(input).flatMap((owner) =>
    DeviceState.recordPullRequestWait(input.paths, owner.launchId, (row) => ({
      progress: row.progress,
      waitState: "waiting",
    }))
      .toAsync()
      .flatMap((pr): AsyncResult<Outcome, Failure> => {
        // Stryker disable next-line ConditionalExpression: equivalent: the start write always changes the row, so it never returns null
        if (pr === null)
          // Stryker disable next-line ObjectLiteral,StringLiteral: equivalent: the start write never returns null, so this failure is never returned
          return ErrAsync<Failure>({ reason: "pr_not_associated", detail: "No PR is recorded." });
        // The lease shows that this wait still runs. A killed wait becomes visible in next.
        const release = DeviceState.holdPullRequestWait(
          input.paths,
          owner.sourceId,
          owner.assignment,
        );
        return fromPromise(async () => {
          try {
            return await poll(input, owner, pr, Date.now() + input.timeoutSeconds * 1000);
          } finally {
            release();
          }
        }, qualify).flatMap((result) => result);
      }),
  );
}

/**
 * PR operations of the owner WorkerAgent, whose worktree is the only assignment selector, and
 * the cleanup that follows a verified merge, which the SuperAgent can repeat after a failure.
 */
export const PullRequests = {
  merge(input: Request) {
    return merge(input);
  },
  cleanup(input: Parameters<typeof cleanup>[0]) {
    return cleanup(input);
  },
  associate(input: Request) {
    return associate(input);
  },
  wait(input: Request & { timeoutSeconds: number }) {
    return wait(input);
  },
};
