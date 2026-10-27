// Bun has no realpath API.
import { realpath } from "node:fs/promises";
import { Err, Ok, OkAsync, fromPromise, type Result } from "unthrown";
import { DeviceState } from "../device-state/main.ts";
import { Environment } from "../environment/main.ts";
import { Herdr } from "../herdr/main.ts";
import { Projects } from "../projects/main.ts";
import { ToolInvocation } from "../tool-invocation/main.ts";
import { WorktreePreparation } from "../worktree-preparation/main.ts";
import {
  cleanupSteps,
  decidePane,
  decideRemoteBranch,
  decideWorktree,
  nextStep,
  type CleanupStep,
  type StepDecision,
} from "./cleanup-machine.ts";
import { deleteRemoteBranch, remoteBranch } from "./github.ts";
import { qualify, type Paths } from "./owner.ts";

type Claimed = Extract<ReturnType<typeof DeviceState.claimCleanup>, { tag: "Ok" }>["value"];
type Failure = { reason: string; detail: string };
type StepResult =
  | { done: true; outcome: string }
  | { done: false; state: "failed" | "blocked"; reason: string; detail: string };
type Request = {
  paths: Paths;
  cwd: string;
  sourceId: string;
  assignment: string;
  personInstructed: boolean;
};

async function git(cwd: string, args: string[]) {
  const result = await ToolInvocation.run({
    tool: "git",
    args: ["-C", cwd, ...args],
    timeoutMs: 60000,
  });
  return result.status === "completed" ? result : null;
}

async function gitText(cwd: string, args: string[]) {
  const result = await git(cwd, args);
  return result?.exitCode === 0 ? result.stdout.trim() : null;
}

async function realOrNull(file: string) {
  return realpath(file).catch(() => null);
}

/** An awaited operation result, with a defect kept as a failure of this step. */
function value<T>(
  result: Result<T, Failure>,
): { ok: true; value: T } | { ok: false; error: Failure } {
  if (result.tag === "Ok") return { ok: true, value: result.value };
  if (result.tag === "Err") return { ok: false, error: result.error };
  return { ok: false, error: { reason: "cleanup_defect", detail: String(result.cause) } };
}

function failed(error: Failure): StepResult {
  return {
    done: false,
    state: "failed",
    reason: "cleanup_failed",
    detail: `${error.reason}: ${error.detail}`,
  };
}

function decided(decision: StepDecision): StepResult | null {
  if (decision.action === "blocked")
    return { done: false, state: "blocked", reason: decision.reason, detail: decision.detail };
  return decision.action === "skip" ? { done: true, outcome: decision.outcome } : null;
}

/** Deletes the branch only while it is at the merged head, then reads it again as proof. */
async function remoteStep(facts: Claimed, personInstructed: boolean): Promise<StepResult> {
  const { repository, branch, mergedHead } = facts.pullRequest;
  const before = value(await remoteBranch(repository, branch));
  if (!before.ok) return failed(before.error);
  const decision = decideRemoteBranch({
    branch,
    sha: before.value,
    mergedHead: mergedHead ?? "",
    personInstructed,
  });
  const early = decided(decision);
  if (early !== null) return early;
  // A lost or refused answer proves nothing, so the branch is read again either way.
  const answer = value(await deleteRemoteBranch(repository, branch));
  const after = value(await remoteBranch(repository, branch));
  if (!after.ok) return failed(after.error);
  if (after.value === null) return { done: true, outcome: "deleted" };
  return failed({
    reason: "github_failed",
    detail:
      `The branch ${branch} still exists after the deletion request. ${answer.ok ? (answer.value ?? "") : answer.error.detail}`.trim(),
  });
}

/** Herdr pane identifiers belong to one server, so only the recorded session closes a pane. */
async function paneStep(facts: Claimed): Promise<StepResult> {
  const { launch } = facts;
  if (launch.paneId === null) return { done: true, outcome: "not_recorded" };
  if (Environment.read().HERDR_SOCKET_PATH !== (launch.herdrSocket ?? undefined))
    return failed({
      reason: "herdr_session_mismatch",
      detail: "Run operator cleanup in a pane of the Herdr session that started the worker.",
    });
  const observed = value(await Herdr.pane(launch.paneId));
  if (!observed.ok) return failed(observed.error);
  const early = decided(
    decidePane({
      recorded: { paneId: launch.paneId, tabId: launch.tabId },
      observed: observed.value,
    }),
  );
  if (early !== null) return early;
  const closed = value(await Herdr.closePane(launch.paneId));
  return closed.ok ? { done: true, outcome: "closed" } : failed(closed.error);
}

type Inspection = {
  real: string | null;
  head: string | null;
  decision: StepDecision;
};

function statusEntries(output: string) {
  const tokens = output.split("\0");
  const entries: { code: string; path: string }[] = [];
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index] ?? "";
    if (token.length < 4) continue;
    const code = token.slice(0, 2);
    entries.push({ code, path: token.slice(3) });
    // A rename or copy names its origin in the next token.
    if (/[RC]/.test(code)) index++;
  }
  return entries;
}

/** The path is its own Git top level and shares the controlling checkout's repository. */
async function recordedCheckout(real: string, checkout: string) {
  const top = await gitText(real, ["rev-parse", "--show-toplevel"]);
  const commonArgs = ["rev-parse", "--path-format=absolute", "--git-common-dir"];
  const common = await gitText(real, commonArgs);
  const controller = await gitText(checkout, commonArgs);
  return (
    top !== null &&
    (await realOrNull(top)) === real &&
    common !== null &&
    controller !== null &&
    (await realOrNull(common)) === (await realOrNull(controller))
  );
}

/** Identity first, then every change, untracked file, ignored entry, and unlanded commit. */
async function inspect(
  paths: Paths,
  facts: Claimed,
  personInstructed: boolean,
): Promise<Inspection> {
  const { launch, pullRequest, checkout } = facts;
  const base = {
    path: launch.worktreePath,
    expectedBranch: pullRequest.branch,
    personInstructed,
  };
  const real = launch.worktreePath === null ? null : await realOrNull(launch.worktreePath);
  const sameRepository = real !== null && (await recordedCheckout(real, checkout));
  const empty = { changed: [], unknownIgnored: [], landed: true };
  if (real === null || !sameRepository)
    return {
      real,
      head: null,
      decision: decideWorktree({
        ...base,
        ...empty,
        exists: real !== null,
        sameRepository,
        branch: null,
      }),
    };
  const branch = await gitText(real, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
  const head = await gitText(real, ["rev-parse", "--verify", "HEAD"]);
  const ancestor = await git(real, [
    "merge-base",
    "--is-ancestor",
    "HEAD",
    pullRequest.mergedHead ?? "",
  ]);
  const status = await git(real, [
    "status",
    "--porcelain=v1",
    "-z",
    "--ignored=matching",
    "--untracked-files=all",
  ]);
  if (status?.exitCode !== 0)
    return {
      real,
      head,
      decision: {
        action: "blocked",
        reason: "cleanup_unlanded_work",
        detail: `Git could not inspect ${real}, so its work is not proven landed. Repeat operator cleanup after the Git failure is resolved.`,
      },
    };
  const entries = statusEntries(status.stdout);
  const ignored = entries.filter((entry) => entry.code === "!!").map((entry) => entry.path);
  const classified = await WorktreePreparation.classifyIgnored({
    paths,
    worktree: real,
    controller: checkout,
    ignored,
  });
  const unknownIgnored = classified.tag === "Ok" ? classified.value.unknown : ignored;
  return {
    real,
    head,
    decision: decideWorktree({
      ...base,
      exists: true,
      sameRepository,
      branch,
      landed: head !== null && ancestor?.exitCode === 0,
      changed: entries.filter((entry) => entry.code !== "!!").map((entry) => entry.path),
      unknownIgnored,
    }),
  };
}

/**
 * Herdr closes a worktree's workspace with its last pane, so Git removes a worktree that has no
 * open workspace. Neither forces unless the person instructed it, and Git keeps ignored files
 * out of its own refusal, so preparation output does not block the removal.
 */
async function removeWorktree(checkout: string, real: string, force: boolean) {
  const workspaces = value(await Herdr.workspaces());
  if (!workspaces.ok) return workspaces;
  let workspaceId: string | null = null;
  for (const workspace of workspaces.value)
    if (
      workspace.linked &&
      workspace.checkout !== null &&
      (await realOrNull(workspace.checkout)) === real
    )
      workspaceId = workspace.workspaceId;
  if (workspaceId !== null) return value(await Herdr.removeWorktree({ workspaceId, force }));
  const removed = await git(checkout, ["worktree", "remove", ...(force ? ["--force"] : []), real]);
  return removed?.exitCode === 0
    ? { ok: true as const, value: undefined }
    : {
        ok: false as const,
        error: {
          reason: "git_failed",
          detail: `git worktree remove failed: ${(removed?.stderr ?? "Git did not answer.").trim()}`,
        },
      };
}

/**
 * A worktree folder that is already gone can leave its Git registration and its local branch.
 * Git removes only that registration, and the branch goes only while it is landed.
 */
async function forgetWorktree(facts: Claimed) {
  const { checkout, launch, pullRequest } = facts;
  if (launch.worktreePath !== null)
    await git(checkout, ["worktree", "remove", launch.worktreePath]);
  const ref = `refs/heads/${pullRequest.branch}`;
  const head = await gitText(checkout, ["rev-parse", "--verify", "--quiet", ref]);
  if (head === null) return "absent";
  const landed =
    (await git(checkout, ["merge-base", "--is-ancestor", head, pullRequest.mergedHead ?? ""]))
      ?.exitCode === 0;
  const deleted = landed && (await git(checkout, ["update-ref", "-d", ref, head]))?.exitCode === 0;
  return deleted ? "absent" : "absent, local branch kept";
}

async function worktreeStep(
  paths: Paths,
  facts: Claimed,
  personInstructed: boolean,
): Promise<StepResult> {
  const inspection = await inspect(paths, facts, personInstructed);
  if (inspection.decision.action === "skip" && inspection.decision.outcome === "absent")
    return { done: true, outcome: await forgetWorktree(facts) };
  const early = decided(inspection.decision);
  if (early !== null) return early;
  if (inspection.real === null || inspection.decision.action !== "dispose")
    return failed({ reason: "cleanup_defect", detail: "The worktree inspection has no path." });
  const removed = await removeWorktree(facts.checkout, inspection.real, inspection.decision.force);
  if (!removed.ok) return failed(removed.error);
  // The local branch goes only while it still names the inspected head.
  const branch = facts.pullRequest.branch;
  const deleted =
    inspection.head !== null &&
    (await git(facts.checkout, ["update-ref", "-d", `refs/heads/${branch}`, inspection.head]))
      ?.exitCode === 0;
  return { done: true, outcome: deleted ? "removed" : "removed, local branch kept" };
}

function runStep(step: CleanupStep, paths: Paths, facts: Claimed, personInstructed: boolean) {
  if (step === "remote_branch") return remoteStep(facts, personInstructed);
  if (step === "pane") return paneStep(facts);
  return worktreeStep(paths, facts, personInstructed);
}

/** Runs the remaining steps in the declared order and stops at the first failure. */
async function steps(request: Request, facts: Claimed) {
  const outcomes: { step: CleanupStep; outcome: string }[] = [];
  let step = cleanupSteps.find((name) => name === facts.cleanup.step) ?? null;
  // The person's instruction covers only the blocked step whose detail the person read.
  const authorized = facts.cleanup.state === "blocked" ? step : null;
  while (step !== null) {
    const result = await runStep(
      step,
      request.paths,
      facts,
      request.personInstructed && step === authorized,
    );
    if (!result.done) {
      const recorded = DeviceState.advanceCleanup(
        request.paths,
        request.sourceId,
        request.assignment,
        {
          step,
          state: result.state,
          reason: result.reason,
          detail: result.detail,
          release: true,
        },
      );
      if (recorded.tag !== "Ok") return recorded.map(() => outcomes);
      return Err<Failure>({ reason: result.reason, detail: `${step}: ${result.detail}` });
    }
    outcomes.push({ step, outcome: result.outcome });
    const next = nextStep(step);
    const recorded = DeviceState.advanceCleanup(
      request.paths,
      request.sourceId,
      request.assignment,
      {
        step: next,
        state: next === null ? "done" : "pending",
        reason: null,
        detail: null,
        release: next === null,
      },
    );
    if (recorded.tag !== "Ok") return recorded.map(() => outcomes);
    step = next;
  }
  return Ok(outcomes);
}

/**
 * Disposes the resources of a verified merge in the declared order: the remote branch, the
 * worker pane, then the worktree. Each step observes its resource first, so a repeated or
 * restarted cleanup continues where the last one stopped and never repeats a finished step.
 */
export function cleanup(request: Request) {
  return Projects.current(request).flatMap(({ data: project }) =>
    DeviceState.claimCleanup(
      request.paths,
      project.repository,
      request.sourceId,
      request.assignment,
    )
      .toAsync()
      .flatMap((facts) => {
        const data = { sourceId: request.sourceId, assignment: request.assignment };
        if (facts.cleanup.state === "done")
          return OkAsync({ reason: "cleanup_unchanged", data: { ...data, steps: [] } });
        const release = DeviceState.holdCleanup(
          request.paths,
          request.sourceId,
          request.assignment,
        );
        return fromPromise(async () => {
          try {
            return await steps(request, facts);
          } finally {
            release();
          }
        }, qualify)
          .flatMap((result) => result)
          .map((outcomes) => ({ reason: "cleanup_finished", data: { ...data, steps: outcomes } }));
      }),
  );
}
