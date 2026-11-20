import { Err, ErrAsync, Ok, OkAsync, fromPromise, type AsyncResult, type Result } from "unthrown";
import { DeviceState } from "../device-state/main.ts";
import { Environment } from "../environment/main.ts";
import { Herdr } from "../herdr/main.ts";
import { Projects } from "../projects/main.ts";
import { ToolInvocation } from "../tool-invocation/main.ts";
import { WorkSources } from "../work-sources/main.ts";
import { WorkerDispatch } from "../worker-dispatch/main.ts";
import { decideInternalReview, decideOwnership } from "./internal-review-machine.ts";
import { openPullRequests } from "./github.ts";
import { qualify, resolveOwner, type Owner, type Paths } from "./owner.ts";
import type { Refusal } from "../../lib/cli-result.ts";

type Failure = Refusal;
type HandoffContinuation = Parameters<typeof DeviceState.checkHandoffContinuation>[1];
const handoffRecovery = {
  decider: "super-agent" as const,
  question:
    "How should the failed internal-review handoff be recovered from its recorded progress?",
};
type Claimed = Extract<ReturnType<typeof DeviceState.claimHandoff>, { tag: "Ok" }>["value"];

// A built release runs `cli.js`, and a source install runs `cli.ts`.
const packageRoot = new URL("../../", import.meta.url);

async function entryPoint() {
  // Stryker disable next-line StringLiteral: no rule: only a built release has cli.js, and a source test cannot add one to the shared package root
  const built = Bun.fileURLToPath(new URL("cli.js", packageRoot));
  return (await Bun.file(built).exists())
    ? built
    : Bun.fileURLToPath(new URL("cli.ts", packageRoot));
}

async function git(cwd: string, args: string[]) {
  const result = await ToolInvocation.run({
    tool: "git",
    args: ["-C", cwd, ...args],
    timeoutMs: 10000,
  });
  // Stryker disable next-line ConditionalExpression: equivalent: a result that did not complete has no exit code, so the exit code check alone returns null
  return result.status === "completed" && result.exitCode === 0 ? result.stdout.trim() : null;
}

/** The worktree's changes, untracked files included, and its head commit. */
export function worktreeFacts(worktree: string) {
  return fromPromise(async () => {
    const status = await git(worktree, ["status", "--porcelain", "--untracked-files=normal"]);
    return {
      // An unreadable status cannot prove the worktree clean.
      changed: status !== "",
      localHead: await git(worktree, ["rev-parse", "--verify", "HEAD"]),
    };
  }, qualify);
}

/** The legacy merge-condition name now witnesses only an explicit ready transition. */
export function reviewEnded(owner: Pick<Owner, "readiness">) {
  return owner.readiness !== null;
}

/**
 * Closing the implementer's pane ends the associate process, so the handoff runs in its own
 * process group from the controlling checkout. A start that fails stays visible as stopped.
 */
export function startHandoff(paths: Paths, owner: Owner) {
  return fromPromise(
    async () =>
      ToolInvocation.detach({
        tool: process.execPath,
        args: [
          await entryPoint(),
          "dispatch",
          "--source",
          owner.sourceId,
          "--assignment",
          owner.assignment,
          "--after-pid",
          String(process.pid),
          "--json",
        ],
        cwd: owner.checkout,
      }),
    qualify,
  )
    .flatMap((pid) => DeviceState.startHandoff(paths, owner.sourceId, owner.assignment, pid))
    .map(() => "started");
}

// The associate result reaches the implementer before its pane closes.
async function afterExit(pid: number | null) {
  const deadline = Date.now() + 10000;
  while (pid !== null && Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch {
      return;
    }
    await Bun.sleep(100);
  }
}

/** Herdr pane identifiers belong to one server, so only the recorded session closes a pane. */
async function closeImplementer(facts: Claimed): Promise<Failure | null> {
  const { implementer } = facts;
  // Stryker disable next-line ConditionalExpression: equivalent: the decision closes only a recorded pane
  if (implementer.paneId === null) return null;
  if (Environment.read().HERDR_SOCKET_PATH !== (implementer.herdrSocket ?? undefined))
    return {
      reason: "herdr_session_mismatch",
      next: {
        decider: "super-agent",
        question: "Which pane of the recorded Herdr session should retry this handoff?",
      },
      state: {
        expectedSocket: implementer.herdrSocket,
        actualSocket: Environment.read().HERDR_SOCKET_PATH ?? null,
      },
      detail:
        "Run operator dispatch in a pane of the Herdr session that started the outgoing worker.",
    };
  const closed = await Herdr.closePane(implementer.paneId);
  if (closed.tag === "Ok") return null;
  return closed.tag === "Err"
    ? closed.error
    : { reason: "handoff_defect", detail: String(closed.cause), next: handoffRecovery };
}

type Launch = Extract<Awaited<ReturnType<typeof WorkerDispatch.dispatch>>, { tag: "Ok" }>["value"];
type RecoveryAudit = NonNullable<
  Extract<ReturnType<typeof DeviceState.readInternalReviewRecovery>, { tag: "Ok" }>["value"]
>;

function recoveryPullRequest(audit: RecoveryAudit) {
  return openPullRequests(audit.repository, audit.branch).flatMap((found) =>
    fromPromise(async () => {
      const pr = found[0];
      const branch = await git(audit.worktreePath, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
      if (
        found.length !== 1 ||
        // Stryker disable next-line OptionalChaining: equivalent: openPullRequests returns a dense parsed array; found.length !== 1 short-circuits before pr is read unless index zero exists. The optional access narrows pr for TypeScript's noUncheckedIndexedAccess
        pr?.number !== audit.number ||
        pr.url !== audit.url ||
        pr.head !== audit.head ||
        branch !== audit.branch
      )
        return Err<Failure>({
          reason: "internal_review_recovery_incompatible",
          detail:
            "The recovered handoff no longer matches its authorized PR, branch, and head. Nothing was handed off.",
          next: handoffRecovery,
        });
      return Ok(pr);
    }, qualify).flatMap((result) => result),
  );
}

/** A recovered handoff rechecks its pinned authorization at every destructive retry. */
async function recoveryGate(request: HandoffRequest & { repository: string }, facts: Claimed) {
  const read = DeviceState.readInternalReviewRecovery(
    request.paths,
    request.repository,
    request.sourceId,
    request.assignment,
  );
  if (read.tag !== "Ok") return failure(read);
  const audit = read.value;
  if (audit === null || audit.implementerLaunchId !== facts.handoff.outgoingLaunchId) return null;
  const confirmed = DeviceState.recoverInternalReview(request.paths, {
    ...audit,
    launchId: audit.implementerLaunchId,
  });
  if (confirmed.tag !== "Ok") return failure(confirmed);
  if (facts.implementer.state === "running") {
    const owner = await resolveOwner({ paths: request.paths, cwd: audit.worktreePath });
    if (owner.tag !== "Ok") return failure(owner);
  }
  const found = await recoveryPullRequest(audit);
  if (found.tag !== "Ok") return failure(found);
  const pr = found.value;
  const tree = await worktreeFacts(audit.worktreePath);
  if (tree.tag !== "Ok") return failure(tree);
  const decision = decideInternalReview({
    event: "associate",
    internalReview: true,
    draft: pr.draft,
    changed: tree.value.changed,
    localHead: tree.value.localHead,
    prHead: audit.head,
  });
  return decision.result === "refused" ? decision : null;
}

function failure(
  result: { tag: "Err"; error: Failure } | { tag: "Defect"; cause: unknown },
): Failure {
  if (result.tag === "Err") return result.error;
  return {
    reason: "handoff_defect",
    detail: String(result.cause),
    next: handoffRecovery,
  };
}

function runHandoff(
  request: HandoffRequest & { repository: string },
  facts: Claimed,
): AsyncResult<Launch | null, Failure> {
  return fromPromise<Result<Launch | null, Failure>, ReturnType<typeof qualify>>(async () => {
    await afterExit(request.afterPid);
    if (request.continuation !== undefined) {
      const checked = DeviceState.checkHandoffContinuation(request.paths, request.continuation);
      if (checked.tag !== "Ok") return checked.map(() => null);
    }
    const recovery = await recoveryGate(request, facts);
    if (recovery !== null)
      return Err(
        recovery.reason === "internal_review_recovery_incompatible"
          ? {
              ...recovery,
              detail:
                "The recorded recovery does not authorize this handoff. No implementer pane was closed and no successor was started. Handoff progress was claimed before this refusal.",
              state: { ...recovery.state, handoffClaimed: true },
            }
          : recovery,
      );
    // Recovery can await live PR/Git reads; it cannot extend a continuation's authorization.
    if (request.continuation !== undefined) {
      const checked = DeviceState.checkHandoffContinuation(request.paths, request.continuation);
      if (checked.tag !== "Ok") return checked.map(() => null);
    }
    const decision = decideInternalReview({
      event: "handoff",
      implementer: { state: facts.implementer.state, paneId: facts.implementer.paneId },
      reviewerStarted: facts.latest.id !== facts.implementer.id,
    });
    // Stryker disable next-line ConditionalExpression: equivalent: the handoff event always decides a handoff
    if (decision.result !== "handoff")
      return Err(
        // Stryker disable next-line ObjectLiteral: equivalent: runHandoff calls the pure machine with the fixed handoff event. That event always returns handoff for every implementer state/pane/reviewer flag; it never returns a refusal or another event decision. The existing conditional is already marked equivalent. Keep the TypeScript narrowing guard and disposition only its impossible error object/reason/detail children.
        {
          // Stryker disable next-line StringLiteral: equivalent: runHandoff calls the pure machine with the fixed handoff event. That event always returns handoff for every implementer state/pane/reviewer flag; it never returns a refusal or another event decision. The existing conditional is already marked equivalent. Keep the TypeScript narrowing guard and disposition only its impossible error object/reason/detail children.
          reason: "handoff_defect",
          // Stryker disable next-line StringLiteral: equivalent: runHandoff calls the pure machine with the fixed handoff event. That event always returns handoff for every implementer state/pane/reviewer flag; it never returns a refusal or another event decision. The existing conditional is already marked equivalent. Keep the TypeScript narrowing guard and disposition only its impossible error object/reason/detail children.
          detail: "The handoff event decided no handoff.",
          next: handoffRecovery,
        },
      );
    if (decision.closePane) {
      const closed = await closeImplementer(facts);
      if (closed !== null) return Err(closed);
    }
    if (!decision.dispatch) return Ok(null);
    return DeviceState.finishImplementer(request.paths, facts.implementer.id, request.continuation)
      .toAsync()
      .flatMap(() =>
        DeviceState.completeParking(
          request.paths,
          {
            repository: request.repository,
            sourceId: request.sourceId,
            assignment: request.assignment,
          },
          request.continuation,
        ),
      )
      .flatMap((parked): AsyncResult<Launch | null, Failure> =>
        parked
          ? OkAsync(null)
          : WorkerDispatch.dispatch({
              paths: request.paths,
              cwd: facts.checkout,
              sourceId: request.sourceId,
              assignment: request.assignment,
              handoff: true,
              continuation: request.continuation,
            }),
      );
  }, qualify).flatMap((result) => result);
}

type HandoffRequest = {
  paths: Paths;
  cwd: string;
  sourceId: string;
  assignment: string;
  afterPid: number | null;
  continuation?: HandoffContinuation;
};

/**
 * Hands a draft PR from its implementer to a fresh reviewer: it closes the implementer's pane,
 * then starts the reviewer as the next launch in the same worktree. A failure before the
 * reviewer's start stays recorded until a retry or a SuperAgent dispatch finishes it.
 */
export function handoff(request: HandoffRequest) {
  return Projects.current(request).flatMap(({ data: project }) =>
    DeviceState.claimHandoff(
      request.paths,
      project.repository,
      request.sourceId,
      request.assignment,
      request.afterPid,
      request.continuation,
    )
      .toAsync()
      .flatMap((facts): AsyncResult<Launch | null, Failure> => {
        if (facts.handoff.handoffState === "done") return OkAsync(null);
        const release = DeviceState.holdHandoff(
          request.paths,
          request.sourceId,
          request.assignment,
          request.continuation,
        );
        return fromPromise(async () => {
          try {
            const step = await runHandoff({ ...request, repository: project.repository }, facts);
            if (step.tag !== "Err") return step;
            // A failed reviewer start already ended the handoff, and next shows that launch.
            DeviceState.failHandoff(
              request.paths,
              request.sourceId,
              request.assignment,
              `${step.error.reason}: ${step.error.detail}`,
              request.continuation,
            );
            return Err(step.error);
          } finally {
            release();
          }
        }, qualify).flatMap((result) => result);
      }),
  );
}

type DispatchInput = Omit<HandoffRequest, "afterPid" | "continuation"> & {
  afterPid?: number | null;
};
type DispatchPermission = { continuation: HandoffContinuation | null };
type DispatchOutcome = Launch | { sourceId: string; assignment: string; parked: boolean };

/** Publication gets one second, read-only, then fails closed. Scheduler progress is not guaranteed. */
export function dispatchPermission(input: DispatchInput): AsyncResult<DispatchPermission, Failure> {
  return fromPromise(async () => {
    const supervised = await WorkSources.checkSupervisor(input);
    const afterPid = input.afterPid ?? null;
    const internal = afterPid !== null;
    if (supervised.tag === "Ok" && !internal) return Ok<DispatchPermission>({ continuation: null });
    if (supervised.tag === "Defect") return supervised.map(() => ({ continuation: null }));
    if (
      supervised.tag === "Err" &&
      (supervised.error.reason !== "source_supervised_elsewhere" || !internal)
    )
      return Err<Failure>({ ...supervised.error, next: supervised.error.next ?? handoffRecovery });
    if (afterPid === null || afterPid <= 0)
      return Err<Failure>({
        reason: "handoff_continuation_refused",
        detail:
          "An internal continuation needs a positive publication PID and its own recorded hold.",
        next: handoffRecovery,
        state: { continuationAuthorized: false },
      });
    const project = await Projects.current(input);
    if (project.tag === "Defect") return project.map(() => ({ continuation: null }));
    if (project.tag === "Err")
      return Err<Failure>({ ...project.error, next: project.error.next ?? handoffRecovery });
    const target = {
      repository: project.value.data.repository,
      sourceId: input.sourceId,
      assignment: input.assignment,
    };
    return await waitForPublication(input, target, afterPid);
  }, qualify).flatMap((result) => result);
}

function waitForPublication(
  input: DispatchInput,
  target: { repository: string; sourceId: string; assignment: string },
  publishingPid: number,
): AsyncResult<DispatchPermission, Failure> {
  return fromPromise(async () => {
    const values = Environment.read();
    const context = {
      pane: values.HERDR_PANE_ID ?? null,
      socket: values.HERDR_SOCKET_PATH ?? null,
    };
    const deadline = Date.now() + 1000;
    while (true) {
      const checked = DeviceState.readHandoffContinuation(
        input.paths,
        target,
        context,
        publishingPid,
      );
      if (checked.tag !== "Ok") return checked.map(({ identity }) => ({ continuation: identity }));
      if (checked.value.published)
        return Ok<DispatchPermission>({ continuation: checked.value.identity });
      if (Date.now() >= deadline)
        return Err<Failure>({
          reason: "handoff_publication_timed_out",
          detail:
            "The associating process did not publish this continuation's PID within one second. No handoff was claimed.",
          next: {
            command: "operator next",
            why: "The supervisor can recover the stopped handoff.",
          },
          state: { continuationAuthorized: false },
        });
      await Bun.sleep(10);
    }
  }, qualify).flatMap((result) => result);
}

/** A foreign continuation never falls back to ordinary supervisor dispatch. */
export function dispatch(input: DispatchInput): AsyncResult<DispatchOutcome, Failure> {
  return dispatchPermission(input).flatMap(({ continuation }) => {
    if (continuation === null) return supervisorDispatch(input);
    return WorkerDispatch.checkHandoff(input)
      .flatMap(() => handoff({ ...input, afterPid: input.afterPid ?? null, continuation }))
      .flatMap((launch): AsyncResult<DispatchOutcome, Failure> =>
        launch === null ? parkingResult(input) : OkAsync(launch),
      );
  });
}

function parkingResult(input: DispatchInput): AsyncResult<DispatchOutcome, Failure> {
  return WorkSources.show(input).flatMap((source) => {
    const parking = source?.pullRequests.find(
      (row) => row.assignment === input.assignment,
    )?.parking;
    return parking?.state === "parked"
      ? OkAsync({ sourceId: input.sourceId, assignment: input.assignment, parked: true })
      : ErrAsync<Failure>({
          reason: "handoff_continuation_refused",
          detail: "The pending continuation was consumed. No replacement was dispatched.",
          next: {
            command: "operator next",
            why: "Read the assignment's recorded next action.",
          },
          state: { continuationAuthorized: false },
        });
  });
}

/** Ordinary supervisor recovery keeps its independent dispatch authority. */
function supervisorDispatch(input: DispatchInput): AsyncResult<DispatchOutcome, Failure> {
  return WorkSources.show(input).flatMap((source) => {
    const parking = source?.pullRequests.find(
      (row) => row.assignment === input.assignment,
    )?.parking;
    if (source !== undefined && parking?.state === "parked" && parking.events.length > 0)
      return DeviceState.resumeParkedPullRequest(input.paths, {
        repository: source.repository,
        sourceId: input.sourceId,
        assignment: input.assignment,
      })
        .toAsync()
        .flatMap(() => supervisorDispatch(input));
    const recorded = source?.handoffs.find((row) => row.assignment === input.assignment);
    if (recorded === undefined || recorded.handoffState === "done")
      return WorkerDispatch.dispatch(input);
    return WorkerDispatch.checkHandoff(input)
      .flatMap(() => handoff({ ...input, afterPid: input.afterPid ?? null }))
      .flatMap((launch): AsyncResult<DispatchOutcome, Failure> =>
        launch === null ? parkingResult(input) : OkAsync(launch),
      );
  });
}

function readFindings(file: string) {
  return fromPromise(() => (file === "-" ? Bun.stdin.text() : Bun.file(file).text()), qualify);
}

/**
 * Records the findings of one internal review round at the worktree head. The rule runs again
 * in the write on the rounds that it reads, so two rounds can never share a number.
 */
export function round(input: { paths: Paths; cwd: string; file: string }) {
  return resolveOwner(input).flatMap((owner) =>
    readFindings(input.file).flatMap((content) =>
      WorkSources.parseFindings(content)
        .toAsync()
        .flatMap((findings) =>
          worktreeFacts(owner.worktreePath).flatMap(({ localHead }) =>
            DeviceState.recordInternalReviewRound(input.paths, owner.launchId, (facts) => {
              const decision = decideInternalReview({
                event: "round",
                review: { state: facts.review.state, rounds: facts.rounds },
                implementer: facts.review.implementerLaunchId === facts.launch.id,
                localHead,
              });
              if (decision.result !== "round")
                return Err<Failure>(
                  decision.result === "refused"
                    ? decision
                    : {
                        reason: "internal_review_defect",
                        // Stryker disable next-line ObjectLiteral: equivalent: round calls the pure machine with the fixed round event. Its decision is round or refused for every typed fact. The nested unexpected-event fallback is unreachable; recorded ordinary refusals remain tested through the real machine.
                        next: {
                          // Stryker disable next-line StringLiteral: equivalent: round calls the pure machine with the fixed round event. Its decision is round or refused for every typed fact. The nested unexpected-event fallback is unreachable; recorded ordinary refusals remain tested through the real machine.
                          decider: "super-agent",
                          question:
                            // Stryker disable next-line StringLiteral: equivalent: round calls the pure machine with the fixed round event. Its decision is round or refused for every typed fact. The nested unexpected-event fallback is unreachable; recorded ordinary refusals remain tested through the real machine.
                            "How should the unexpected review-round decision be investigated?",
                        },
                        detail: "The round event decided no round.",
                      },
                );
              return Ok({ head: decision.head, findings: JSON.stringify(findings) });
            }).map((row) => ({
              reason: "pr_round_recorded",
              data: {
                sourceId: owner.sourceId,
                assignment: owner.assignment,
                round: row.number,
                head: row.head,
                findings: findings.length,
                blockers: findings.filter((finding) => finding.severity === "blocker").length,
              },
            })),
          ),
        ),
    ),
  );
}

/** Refuses a PR command of the launch that the handoff ended. */
export function owned(owner: Owner): AsyncResult<Owner, Failure> {
  const refusal = decideOwnership({
    implementer:
      owner.implementerLaunchId === owner.launchId || owner.outgoingLaunchId === owner.launchId,
  });
  return refusal === null ? OkAsync(owner) : ErrAsync(refusal);
}
