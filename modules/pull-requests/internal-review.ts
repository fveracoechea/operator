import { Err, ErrAsync, Ok, OkAsync, fromPromise, type AsyncResult } from "unthrown";
import { DeviceState } from "../device-state/main.ts";
import { Environment } from "../environment/main.ts";
import { Herdr } from "../herdr/main.ts";
import { Projects } from "../projects/main.ts";
import { ToolInvocation } from "../tool-invocation/main.ts";
import { WorkSources } from "../work-sources/main.ts";
import { WorkerDispatch } from "../worker-dispatch/main.ts";
import { decideInternalReview } from "./internal-review-machine.ts";
import { qualify, resolveOwner, type Owner, type Paths } from "./owner.ts";

type Failure = { reason: string; detail: string };
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

/** The launch that the handoff ended no longer owns the PR, also while its pane still runs. */
export function handedOff(owner: Owner): Failure | null {
  return owner.implementerLaunchId === owner.launchId
    ? {
        reason: "pr_handed_off",
        detail:
          "This launch handed the PR to its internal reviewer, so it runs no more PR commands. Stop here. Nothing was changed.",
      }
    : null;
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
          "handoff",
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
      detail: "Run operator handoff in a pane of the Herdr session that started the implementer.",
    };
  const closed = await Herdr.closePane(implementer.paneId);
  if (closed.tag === "Ok") return null;
  return closed.tag === "Err"
    ? closed.error
    : { reason: "handoff_defect", detail: String(closed.cause) };
}

type Step = { ok: true; reviewer: object | null } | { ok: false; error: Failure };

function failure<T>(
  result:
    | { tag: "Err"; error: Failure }
    | { tag: "Defect"; cause: unknown }
    | { tag: "Ok"; value: T },
): Failure {
  if (result.tag === "Err") return result.error;
  return { reason: "handoff_defect", detail: result.tag === "Defect" ? String(result.cause) : "" };
}

async function runHandoff(request: HandoffRequest, facts: Claimed): Promise<Step> {
  await afterExit(request.afterPid);
  const decision = decideInternalReview({
    event: "handoff",
    implementer: { state: facts.implementer.state, paneId: facts.implementer.paneId },
    reviewerStarted: facts.latest.id !== facts.implementer.id,
  });
  // Stryker disable next-line ConditionalExpression: equivalent: the handoff event always decides a handoff
  if (decision.result !== "handoff")
    return {
      ok: false,
      error: { reason: "handoff_defect", detail: "The handoff event decided no handoff." },
    };
  if (decision.closePane) {
    const closed = await closeImplementer(facts);
    if (closed !== null) return { ok: false, error: closed };
  }
  if (!decision.dispatch) return { ok: true, reviewer: null };
  const ended = DeviceState.finishImplementer(request.paths, facts.implementer.id);
  if (ended.tag !== "Ok") return { ok: false, error: failure(ended) };
  const started = await WorkerDispatch.dispatch({
    paths: request.paths,
    cwd: facts.checkout,
    sourceId: request.sourceId,
    assignment: request.assignment,
    handoff: true,
  });
  if (started.tag !== "Ok") return { ok: false, error: failure(started) };
  const launch = started.value;
  return {
    ok: true,
    reviewer: { name: launch.name, paneId: launch.paneId, worktreePath: launch.worktreePath },
  };
}

type HandoffRequest = {
  paths: Paths;
  cwd: string;
  sourceId: string;
  assignment: string;
  afterPid: number | null;
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
    )
      .toAsync()
      .flatMap((facts): AsyncResult<{ reason: string; data: object }, Failure> => {
        const data = { sourceId: request.sourceId, assignment: request.assignment };
        if (facts.review.handoffState === "done")
          return OkAsync({ reason: "handoff_unchanged", data: { ...data, reviewer: null } });
        const release = DeviceState.holdHandoff(
          request.paths,
          request.sourceId,
          request.assignment,
        );
        return fromPromise(async () => {
          try {
            const step = await runHandoff(request, facts);
            if (step.ok)
              return Ok({ reason: "handoff_finished", data: { ...data, reviewer: step.reviewer } });
            // A failed reviewer start already ended the handoff, and next shows that launch.
            DeviceState.failHandoff(
              request.paths,
              request.sourceId,
              request.assignment,
              `${step.error.reason}: ${step.error.detail}`,
            );
            return Err(step.error);
          } finally {
            release();
          }
        }, qualify).flatMap((result) => result);
      }),
  );
}

function readFindings(file: string) {
  return fromPromise(() => Bun.file(file).text(), qualify);
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
  const refusal = handedOff(owner);
  return refusal === null ? OkAsync(owner) : ErrAsync(refusal);
}
