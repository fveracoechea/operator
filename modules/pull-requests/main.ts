import { Err, ErrAsync, OkAsync, fromPromise, type AsyncResult, type Result } from "unthrown";
import { DeviceState } from "../device-state/main.ts";
import { observePullRequest, openPullRequests } from "./github.ts";
import { resolveOwner, qualify, type Owner, type Paths } from "./owner.ts";
import { decideWait, mergeConditions, progressSchema } from "./wait-machine.ts";

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

/** The owner opens the PR with its own tools and closing keywords. The CLI only records it. */
function associate(input: Request) {
  return resolveOwner(input).flatMap((owner) =>
    openPullRequests(owner.repository, owner.branch).flatMap(
      (found): Result<{ reason: string; data: object }, Failure> => {
        const pr = found[0];
        if (pr === undefined || found.length > 1)
          return Err({
            reason: pr === undefined ? "pr_not_found" : "pr_ambiguous",
            detail: `Open exactly one PR from ${owner.branch} in ${owner.repository}, then repeat. Nothing was changed.`,
          });
        return DeviceState.associatePullRequest(input.paths, owner.launchId, {
          number: pr.number,
          url: pr.url,
          branch: owner.branch,
        }).map(({ changed }) => ({
          reason: changed ? "pr_associated" : "pr_unchanged",
          data: { ...summary(owner, pr), state: "pr-open" },
        }));
      },
    ),
  );
}

function progress(text: string) {
  return progressSchema.parse(JSON.parse(text));
}

type Outcome = { reason: string; data: object };
type Recorded = { number: number; url: string };

/** Observes once, records any result, and polls again until the deadline. */
function poll(
  input: Request,
  owner: Owner,
  pr: Recorded,
  deadline: number,
): AsyncResult<Outcome, Failure> {
  return observePullRequest(owner.repository, pr.number).flatMap((observed) => {
    // The decision runs inside the write transaction on the progress that it reads there.
    const outcome: { decision: ReturnType<typeof decideWait> } = { decision: { result: "none" } };
    const data = {
      ...summary(owner, pr),
      head: observed.head,
      mergeConditions: mergeConditions(observed),
    };
    return DeviceState.recordPullRequestWait(input.paths, owner.launchId, (row) => {
      const decision = decideWait({ progress: progress(row.progress), observed });
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
  });
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
        if (pr === null)
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

/** PR operations of the owner WorkerAgent. Its worktree is the only assignment selector. */
export const PullRequests = {
  associate(input: Request) {
    return associate(input);
  },
  wait(input: Request & { timeoutSeconds: number }) {
    return wait(input);
  },
};
