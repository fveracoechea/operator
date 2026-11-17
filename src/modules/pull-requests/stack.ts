import {
  Err,
  Ok,
  OkAsync,
  fromPromise,
  type Result,
  type AsyncResult,
  type AsyncOkOf,
} from "unthrown";
import { DeviceState } from "../device-state/main.ts";
import { WorkerDispatch } from "../worker-dispatch/main.ts";
import { PrStacks } from "../pr-stacks/main.ts";
import { openPullRequests, retarget, readyFacts, markDraft, observeParent } from "./github.ts";
import { resolveOwner, qualify, type Owner, type Paths } from "./owner.ts";
import { stackGit, stackCandidate } from "./stack-git.ts";
import { parentCut } from "./stack-cut.ts";
import { stackParents } from "./stack-parents.ts";
import { stacked, type Relay } from "./relay.ts";
import { startHandoff } from "./internal-review.ts";
import type { Refusal } from "../../lib/cli-result.ts";

type Input = { paths: Paths; cwd: string };
type Plan = ReturnType<typeof PrStacks.operation>;
type StackParent = Plan["parents"][number];
type PreviewInput = Input & { cut?: string; parents?: string[] };
type Outcome = { reason: string; data: Plan };
type Child = AsyncOkOf<ReturnType<typeof openPullRequests>>[number];
type Operation = {
  input: Input;
  owner: Owner;
  plan: Plan;
  revision: number;
  draftConfirmed: boolean;
};

function stop<T, E>(result: Result<T, E>): Result<never, E> {
  return result.flatMap(() => stop(result));
}

function refuse(reason: string, detail: string): Result<never, Refusal> {
  return Err({
    reason,
    detail,
    next: {
      command: "operator pr stack plan",
      why: "Inspect the owned stack and resolve the blocker before another change.",
    },
  });
}

function childFacts(owner: Owner): AsyncResult<Child, Refusal> {
  return openPullRequests(owner.repository, owner.branch).flatMap((found) => {
    const child = found[0];
    return child === undefined || found.length !== 1 || child.number !== owner.pullRequest
      ? refuse("stack_child", "Exactly one associated open PR must match the owned branch.")
      : Ok(child);
  });
}

async function clean(owner: Owner, head: string) {
  const status = await stackGit(owner.worktreePath, [
    "status",
    "--porcelain",
    "--untracked-files=all",
  ]);
  const local = await stackGit(owner.worktreePath, ["rev-parse", "HEAD"]);
  return status.ok && status.out === "" && local.ok && local.out === head;
}

function save(input: Input, owner: Owner, plan: Plan, revision: number | null, held: boolean) {
  return DeviceState.changeStack(input.paths, owner.launchId, plan.id, revision, () =>
    Ok({
      state:
        plan.step === "complete" || plan.step === "cancelled"
          ? plan.step
          : plan.blocker === null
            ? "planned"
            : "blocked",
      data: JSON.stringify(plan),
      ownerPid: held ? process.pid : null,
    }),
  );
}

function advance(operation: Operation, change: Partial<Plan>): Result<void, Refusal> {
  const next = { ...operation.plan, ...change };
  return save(operation.input, operation.owner, next, operation.revision, true).map((row) => {
    operation.plan = next;
    operation.revision = row.revision;
    return undefined;
  });
}

function pushedHead(owner: Owner, remote: string): AsyncResult<string, Refusal> {
  return fromPromise(async () => {
    const read = await stackGit(owner.worktreePath, [
      "ls-remote",
      "--exit-code",
      remote,
      `refs/heads/${owner.branch}`,
    ]);
    return read.ok
      ? Ok(read.out.split("\t")[0] ?? "")
      : refuse("stack_remote", "The pushed child head could not be established.");
  }, qualify).flatMap((result) => result);
}

function synchronizedRemote(owner: Owner, child: Child): AsyncResult<string, Refusal> {
  return fromPromise(async () => {
    if (!(await clean(owner, child.head)))
      return refuse(
        "stack_unclean",
        "Commit and push all child work before planning a stack refresh.",
      );
    const remote = await stackGit(owner.worktreePath, ["config", `branch.${owner.branch}.remote`]);
    if (!remote.ok || remote.out === "")
      return refuse("stack_remote", "Push the owned branch with an upstream before planning.");
    const pushed = await pushedHead(owner, remote.out);
    if (pushed.tag !== "Ok") return stop(pushed);
    return pushed.value === child.head
      ? Ok(remote.out)
      : refuse("stack_unsynced", "The local, pushed, and observed child heads must match.");
  }, qualify).flatMap((result) => result);
}

function oldCut(
  input: PreviewInput,
  owner: Owner,
  child: Child,
  parents: StackParent[],
  remote: string,
): AsyncResult<string, Refusal> {
  return fromPromise(async () => {
    const stored = DeviceState.readStackBases(input.paths, owner.repository, owner.sourceId);
    if (stored.tag !== "Ok") return stop(stored);
    const binding = stored.value.find(
      (row) => row.assignment === owner.assignment && row.branch === owner.branch,
    );
    const previous = binding === undefined ? null : PrStacks.decode(binding.data);
    const parent = parents.find((row) => row.branch === child.base);
    let cut: string;
    if (previous !== null && previous.branch === child.base) {
      if (input.cut !== undefined && input.cut !== previous.head)
        return refuse(
          "stack_attribution",
          "The requested cut differs from the recorded dependency-only base.",
        );
      cut = previous.head;
    } else {
      if (parent === undefined)
        return refuse(
          "stack_attribution",
          "The existing base must identify a proven prerequisite before this refresh.",
        );
      const historical = await parentCut({
        cwd: owner.worktreePath,
        branch: parent.branch,
        remote,
        parentHead: parent.head,
        childHead: child.head,
        requested: input.cut,
      });
      if (!historical.ok) return refuse("stack_attribution", historical.detail);
      cut = historical.out;
    }
    return (await stackGit(owner.worktreePath, ["merge-base", "--is-ancestor", cut, child.head])).ok
      ? Ok(cut)
      : refuse("stack_attribution", "The proven dependency cut is not inherited by this child.");
  }, qualify).flatMap((result) => result);
}

function preview(input: PreviewInput, owner: Owner): AsyncResult<Outcome, Refusal> {
  return childFacts(owner).flatMap((child) =>
    synchronizedRemote(owner, child).flatMap((remote) =>
      fromPromise(async () => {
        const parents = await stackParents({
          paths: input.paths,
          owner,
          additional: input.parents ?? [],
        });
        if (parents.tag !== "Ok") return stop(parents);
        const target = await PrStacks.prepare({
          cwd: owner.worktreePath,
          repository: owner.repository,
          remote,
          parents: parents.value,
          namespace: `${owner.sourceId}/${owner.assignment}`,
        });
        if (target.tag !== "Ok") return stop(target);
        const cut = await oldCut(input, owner, child, target.value.parents, remote);
        if (cut.tag !== "Ok") return stop(cut);
        const plan: Plan = {
          id: crypto.randomUUID(),
          repository: owner.repository,
          sourceId: owner.sourceId,
          assignment: owner.assignment,
          launchId: owner.launchId,
          previousOwners: [],
          number: child.number,
          branch: owner.branch,
          head: child.head,
          base: child.base,
          cut: cut.value,
          remote,
          parents: target.value.parents,
          target: target.value.head,
          targetBranch: target.value.branch,
          managed: target.value.managed,
          retargetAttempted: false,
          blocker: null,
          failures: [],
          pushAttempted: false,
          relayToMain: false,
          candidate: null,
          step: "planned",
        };
        return save(input, owner, plan, null, false).map(() => ({
          reason: "stack_planned",
          data: plan,
        }));
      }, qualify).flatMap((result) => result),
    ),
  );
}

function validateParents(owner: Owner, plan: Plan): AsyncResult<void, Refusal> {
  return fromPromise(async () => {
    for (const parent of plan.parents) {
      if (parent.state === "MERGED") {
        const observed = await validateMergedParent(owner, parent);
        if (observed.tag !== "Ok") return stop(observed);
        continue;
      }
      const read = await openPullRequests(owner.repository, parent.branch);
      if (read.tag !== "Ok") return stop(read);
      const pr = read.value[0];
      if (
        read.value.length !== 1 ||
        pr?.number !== parent.number ||
        pr.head !== parent.head ||
        pr.base !== parent.base
      )
        return refuse(
          "stack_stale",
          "A pinned prerequisite changed. No new inputs were substituted.",
        );
      const pushed = await stackGit(owner.worktreePath, [
        "ls-remote",
        "--exit-code",
        plan.remote,
        `refs/heads/${parent.branch}`,
      ]);
      if (!pushed.ok || pushed.out.split("\t")[0] !== parent.head)
        return refuse("stack_stale", "The pushed prerequisite changed after planning.");
    }
    return Ok(undefined);
  }, qualify).flatMap((result) => result);
}

function validateMergedParent(
  owner: Owner,
  parent: Plan["parents"][number],
): AsyncResult<void, Refusal> {
  return observeParent(owner.repository, parent.number).flatMap((observed) =>
    observed.state === "MERGED" && observed.head === parent.head && observed.base === parent.base
      ? Ok(undefined)
      : refuse("stack_stale", "A merged prerequisite differs from the pinned relay inputs."),
  );
}

function validateTarget(
  owner: Owner,
  plan: Plan,
  defaultBranch: string | null,
): AsyncResult<void, Refusal> {
  if (!plan.relayToMain) return OkAsync(undefined);
  if (defaultBranch !== plan.targetBranch)
    return refuse("stack_stale", "The default branch changed during the pinned relay.").toAsync();
  return fromPromise(async () => {
    const target = await stackGit(owner.worktreePath, [
      "ls-remote",
      "--exit-code",
      plan.remote,
      `refs/heads/${plan.targetBranch}`,
    ]);
    return target.ok && target.out.split("\t")[0] === plan.target
      ? Ok(undefined)
      : refuse("stack_stale", "The default branch moved during the pinned relay.");
  }, qualify).flatMap((result) => result);
}

function preflight(operation: Operation): AsyncResult<void, Refusal> {
  const { input, owner, plan } = operation;
  return fromPromise(async () => {
    const current = await resolveOwner({ ...input, stackOperation: true });
    if (current.tag !== "Ok") return stop(current);
    if (current.value.launchId !== owner.launchId)
      return refuse("stack_stale", "The active owner changed before the next stack effect.");
    const parents = await validateParents(owner, plan);
    if (parents.tag !== "Ok") return stop(parents);
    const child = await childFacts(owner);
    if (child.tag !== "Ok") return stop(child);
    const expectedBase =
      child.value.base === plan.base ||
      (plan.retargetAttempted && child.value.base === plan.targetBranch);
    if (!expectedBase || ![plan.head, plan.candidate].includes(child.value.head))
      return refuse("stack_stale", "The child's PR head or base changed since planning.");
    if (operation.draftConfirmed && !child.value.draft)
      return refuse(
        "stack_draft",
        "The child became ready outside the stack operation. No further effect was authorized.",
      );
    const remote = await pushedHead(owner, plan.remote);
    if (remote.tag !== "Ok") return stop(remote);
    return [plan.head, plan.candidate].includes(remote.value)
      ? await validateTarget(owner, plan, child.value.defaultBranch)
      : refuse("stack_stale", "The remote child moved before the next stack effect.");
  }, qualify).flatMap((result): Result<void, Refusal> => result);
}

function invalidateReview(operation: Operation): AsyncResult<void, Refusal> {
  const { input, owner, plan } = operation;
  return fromPromise(async () => {
    const review = DeviceState.restartStackReview(
      input.paths,
      owner.launchId,
      plan.id,
      operation.revision,
    );
    if (review.tag !== "Ok") return stop(review);
    operation.revision = review.value.revision;
    const child = await childFacts(owner);
    if (child.tag !== "Ok") return stop(child);
    if (!child.value.draft) {
      const facts = await readyFacts(owner.repository, plan.number, "");
      if (facts.tag !== "Ok") return stop(facts);
      if (facts.value.head !== child.value.head)
        return refuse("stack_stale", "The PR moved before its draft transition.");
      const drafted = await markDraft(facts.value.id);
      if (drafted.tag !== "Ok") return stop(drafted);
    }
    const confirmed = await childFacts(owner);
    if (confirmed.tag !== "Ok") return stop(confirmed);
    if (!confirmed.value.draft)
      return refuse(
        "stack_draft",
        "The child must be a confirmed draft before its ancestry changes.",
      );
    operation.draftConfirmed = true;
    return Ok(undefined);
  }, qualify).flatMap((result) => result);
}

function publishBase(operation: Operation): AsyncResult<void, Refusal> {
  const { owner, plan } = operation;
  if (plan.relayToMain) return OkAsync(undefined);
  return PrStacks.publish({
    cwd: owner.worktreePath,
    remote: plan.remote,
    base: {
      head: plan.target,
      branch: plan.targetBranch,
      managed: plan.managed,
      parents: plan.parents,
    },
  });
}

function prepareCandidate(operation: Operation): AsyncResult<void, Refusal> {
  return fromPromise(async () => {
    const { owner, plan } = operation;
    if (plan.step !== "planned") return Ok(undefined);
    if (!(await clean(owner, plan.head)))
      return refuse("stack_unclean", "The worktree no longer matches the clean planned head.");
    const candidate = await stackCandidate(owner.worktreePath, plan.cut, plan.target, plan.head);
    return candidate.ok
      ? advance(operation, { candidate: candidate.out, step: "prepared" })
      : refuse(
          "stack_conflict",
          `Dependency integration conflicts. The child branch and worktree are unchanged. ${candidate.detail}`,
        );
  }, qualify).flatMap((result) => result);
}

function retainOriginal(operation: Operation): AsyncResult<void, Refusal> {
  return fromPromise(async () => {
    const { owner, plan } = operation;
    const ref = `refs/operator/stacks/${plan.id}/original`;
    const backup = await stackGit(owner.worktreePath, ["update-ref", ref, plan.head, ""]);
    if (backup.ok) return Ok(undefined);
    const existing = await stackGit(owner.worktreePath, ["rev-parse", ref]);
    return existing.ok && existing.out === plan.head
      ? Ok(undefined)
      : refuse("stack_backup", "The original child head could not be retained safely.");
  }, qualify).flatMap((result) => result);
}

function installCandidate(operation: Operation): AsyncResult<void, Refusal> {
  return fromPromise(async () => {
    const { owner, plan } = operation;
    if (plan.step !== "prepared") return Ok(undefined);
    const candidate = plan.candidate;
    if (candidate === null) return refuse("stack_stale", "The stack has no prepared head.");
    const retained = await retainOriginal(operation);
    if (retained.tag !== "Ok") return stop(retained);
    const cwd = owner.worktreePath;
    const local = await stackGit(cwd, ["rev-parse", "HEAD"]);
    if (local.out !== plan.head && local.out !== candidate)
      return refuse("stack_stale", "The local child head changed during stack preparation.");
    if (local.out === plan.head && (await clean(owner, plan.head))) {
      const installed = await stackGit(cwd, ["read-tree", "-u", "-m", plan.head, candidate]);
      if (!installed.ok)
        return refuse(
          "stack_install",
          `The prepared tree could not be installed. Original refs remain. ${installed.detail}`,
        );
    }
    const index = await stackGit(cwd, ["diff", "--cached", "--quiet", candidate, "--"]);
    const working = await stackGit(cwd, ["diff", "--quiet", "--"]);
    if (!index.ok || !working.ok)
      return refuse(
        "stack_unclean",
        "The index or worktree differs from the prepared tree. Preserve the work and inspect it.",
      );
    const moved =
      local.out === candidate
        ? { ok: true }
        : await stackGit(cwd, ["update-ref", `refs/heads/${owner.branch}`, candidate, plan.head]);
    return moved.ok
      ? advance(operation, { step: "installed" })
      : refuse("stack_stale", "The owned branch moved before installation completed.");
  }, qualify).flatMap((result) => result);
}

function pushCandidate(operation: Operation): AsyncResult<void, Refusal> {
  return fromPromise(async () => {
    const { owner, plan } = operation;
    if (plan.step !== "installed") return Ok(undefined);
    const candidate = plan.candidate;
    if (candidate === null || !(await clean(owner, candidate)))
      return refuse(
        "stack_unclean",
        "The installed child contains new work or has no prepared head. No push was attempted.",
      );
    const remote = await pushedHead(owner, plan.remote);
    if (remote.tag !== "Ok") return stop(remote);
    if (remote.value === plan.head) {
      const intent = advance(operation, { pushAttempted: true });
      if (intent.tag !== "Ok") return stop(intent);
      const sent = await stackGit(owner.worktreePath, [
        "push",
        `--force-with-lease=refs/heads/${owner.branch}:${plan.head}`,
        plan.remote,
        `${candidate}:refs/heads/${owner.branch}`,
      ]);
      if (!sent.ok)
        return refuse(
          "stack_push",
          `The push is incomplete or uncertain. Resume only this pinned operation. ${sent.detail}`,
        );
    } else if (remote.value !== candidate)
      return refuse("stack_stale", "The remote child no longer matches either pinned head.");
    const verified = await pushedHead(owner, plan.remote);
    if (verified.tag !== "Ok") return stop(verified);
    return verified.value === candidate
      ? advance(operation, { step: "pushed" })
      : refuse("stack_push", "The pushed candidate is unconfirmed. No base change was attempted.");
  }, qualify).flatMap((result) => result);
}

function retargetCandidate(operation: Operation): AsyncResult<void, Refusal> {
  return fromPromise(async () => {
    const { owner, plan } = operation;
    const before = await childFacts(owner);
    if (before.tag !== "Ok") return stop(before);
    if (before.value.head !== plan.candidate)
      return refuse("stack_stale", "GitHub has not confirmed the pushed child head.");
    if (before.value.base === plan.targetBranch) return Ok(undefined);
    if (plan.retargetAttempted)
      return refuse(
        "stack_retarget_uncertain",
        "The earlier base change is not established. Do not repeat an uncertain write.",
      );
    if (before.value.base !== plan.base)
      return refuse("stack_stale", "The PR base changed before retargeting.");
    const intent = advance(operation, { retargetAttempted: true });
    if (intent.tag !== "Ok") return stop(intent);
    await retarget(owner.repository, plan.number, plan.targetBranch);
    const after = await childFacts(owner);
    if (after.tag !== "Ok") return stop(after);
    return after.value.head === plan.candidate && after.value.base === plan.targetBranch
      ? Ok(undefined)
      : refuse(
          "stack_retarget_uncertain",
          "GitHub has not established the requested head and base. No uncertain write will be repeated.",
        );
  }, qualify).flatMap((result) => result);
}

function finishOperation(operation: Operation): AsyncResult<void, Refusal> {
  const { input, owner, plan } = operation;
  const first = plan.parents[0];
  if (first === undefined)
    return refuse("stack_parent", "The stack has no prerequisite identity to retain.").toAsync();
  const complete: Plan = { ...plan, step: "complete" };
  return DeviceState.finishStack(input.paths, owner.launchId, plan.id, operation.revision, {
    data: JSON.stringify(complete),
    base: JSON.stringify({
      head: plan.target,
      branch: plan.targetBranch,
      managed: plan.managed,
      parents: plan.parents,
    }),
    relay: JSON.stringify({
      ...stacked(first),
      state: plan.relayToMain ? "relayed" : "stacked",
      prerequisites: plan.parents,
      cut: plan.target,
      base: plan.targetBranch,
    }),
  })
    .map((row) => {
      operation.revision = row.revision;
      operation.plan = complete;
      return undefined;
    })
    .toAsync();
}

function runOperation(operation: Operation): AsyncResult<void, Refusal> {
  return fromPromise(async () => {
    for (const step of [
      invalidateReview,
      publishBase,
      prepareCandidate,
      installCandidate,
      pushCandidate,
      retargetCandidate,
      finishOperation,
    ]) {
      const guard = await preflight(operation);
      if (guard.tag !== "Ok") return stop(guard);
      const result = await step(operation);
      if (result.tag !== "Ok") return stop(result);
    }
    return Ok(undefined);
  }, qualify).flatMap((result) => result);
}

function apply(input: Input, owner: Owner, id: string): AsyncResult<Outcome, Refusal> {
  return fromPromise(async () => {
    const read = DeviceState.readStack(input.paths, owner.launchId, id);
    if (read.tag !== "Ok") return stop(read);
    const previous = PrStacks.operation(read.value.data);
    const plan = {
      ...previous,
      launchId: owner.launchId,
      previousOwners:
        previous.launchId === owner.launchId
          ? previous.previousOwners
          : [...previous.previousOwners, previous.launchId],
      blocker: null,
    };
    if (plan.step === "complete")
      return (await refreshBrief(input, owner)).map(() => ({
        reason: "stack_unchanged",
        data: plan,
      }));
    if (plan.step === "cancelled")
      return refuse("stack_cancelled", "This operation was cancelled. Create a new pinned plan.");
    const claimed = save(input, owner, plan, read.value.revision, true);
    if (claimed.tag !== "Ok") return stop(claimed);
    const operation: Operation = {
      input,
      owner,
      plan,
      revision: claimed.value.revision,
      draftConfirmed: false,
    };
    const result = await runOperation(operation);
    if (result.tag !== "Ok") {
      const failure = {
        at: new Date().toISOString(),
        reason: result.tag === "Err" ? result.error.reason : "pr_defect",
        detail: result.tag === "Err" ? result.error.detail : String(result.cause),
      };
      operation.plan = {
        ...operation.plan,
        blocker: failure,
        failures: [...operation.plan.failures, failure],
      };
    }
    const released = save(input, owner, operation.plan, operation.revision, false);
    if (result.tag !== "Ok") return stop(result);
    return released
      .toAsync()
      .flatMap(() => refreshBrief(input, owner))
      .map(() => ({ reason: "stack_refreshed", data: operation.plan }));
  }, qualify).flatMap((result) => result);
}

function refreshBrief(input: Input, owner: Owner): AsyncResult<string, Refusal> {
  return WorkerDispatch.refreshStackBrief({
    paths: input.paths,
    cwd: owner.checkout,
    sourceId: owner.sourceId,
    assignment: owner.assignment,
    launchId: owner.launchId,
  });
}

function reviewStack(input: Input, owner: Owner, id: string): AsyncResult<Outcome, Refusal> {
  return fromPromise(async () => {
    const read = DeviceState.readStack(input.paths, owner.launchId, id);
    if (read.tag !== "Ok") return stop(read);
    const plan = PrStacks.operation(read.value.data);
    if (
      plan.step !== "complete" ||
      plan.launchId !== owner.launchId ||
      owner.implementerLaunchId !== owner.launchId ||
      owner.reviewState !== "reviewing"
    )
      return refuse(
        "stack_review",
        "Only the completed stack's current implementer can request its fresh-review handoff.",
      );
    const child = await childFacts(owner);
    if (child.tag !== "Ok") return stop(child);
    if (
      !child.value.draft ||
      child.value.head !== plan.candidate ||
      child.value.base !== plan.targetBranch ||
      !(await clean(owner, child.value.head))
    )
      return refuse(
        "stack_review",
        "Fresh review requires the confirmed clean pushed draft at its new head and base.",
      );
    const parents = await validateParents(owner, plan);
    if (parents.tag !== "Ok") return stop(parents);
    return (await startHandoff(input.paths, owner)).map(() => ({
      reason: "stack_review_started",
      data: plan,
    }));
  }, qualify).flatMap((result) => result);
}

/** Merged-parent relay reuses the same cut, recovery, ownership, and fresh-review rules as an open-parent refresh. */
export function relayStack(
  input: Input,
  owner: Owner,
  relay: Relay,
): AsyncResult<Outcome, Refusal> {
  return childFacts(owner).flatMap((child) =>
    synchronizedRemote(owner, child).flatMap((remote) =>
      fromPromise(async () => {
        const branch = child.defaultBranch;
        const cut = relay.cut;
        if (branch === null || cut === undefined || relay.prerequisites === undefined)
          return refuse(
            "stack_attribution",
            "The managed relay has no recorded dependency cut or default branch.",
          );
        if (
          !(await stackGit(owner.worktreePath, ["merge-base", "--is-ancestor", cut, child.head])).ok
        )
          return refuse(
            "stack_attribution",
            "The recorded integration cut is not inherited by the child.",
          );
        const parents: Plan["parents"] = [];
        for (const parent of relay.prerequisites) {
          const read = await observeParent(owner.repository, parent.number);
          if (read.tag !== "Ok") return stop(read);
          if (read.value.state !== "MERGED" || read.value.base !== branch)
            return refuse(
              "stack_parent",
              "Every prerequisite must merge into the default branch before this relay.",
            );
          parents.push({
            ...parent,
            head: read.value.head,
            base: read.value.base,
            state: "MERGED",
          });
        }
        const fetched = await stackGit(owner.worktreePath, [
          "fetch",
          "--quiet",
          remote,
          `refs/heads/${branch}`,
        ]);
        const target = await stackGit(owner.worktreePath, ["rev-parse", "FETCH_HEAD"]);
        if (!fetched.ok || !target.ok)
          return refuse("stack_remote", "The default branch could not be pinned for relay.");
        const plan: Plan = {
          id: crypto.randomUUID(),
          repository: owner.repository,
          sourceId: owner.sourceId,
          assignment: owner.assignment,
          launchId: owner.launchId,
          previousOwners: [],
          number: child.number,
          branch: owner.branch,
          head: child.head,
          base: child.base,
          cut,
          remote,
          parents,
          target: target.out,
          targetBranch: branch,
          managed: false,
          relayToMain: true,
          retargetAttempted: false,
          blocker: null,
          failures: [],
          pushAttempted: false,
          candidate: null,
          step: "planned",
        };
        const recorded = save(input, owner, plan, null, false);
        return recorded.tag === "Ok" ? await apply(input, owner, plan.id) : stop(recorded);
      }, qualify).flatMap((result): Result<Outcome, Refusal> => result),
    ),
  );
}

function cancelInstalled(
  input: Input,
  owner: Owner,
  plan: Plan,
  revision: number,
): Result<Outcome, Refusal> {
  const first = plan.parents[0];
  if (first === undefined)
    return refuse("stack_cancel_unsafe", "The installed candidate has no dependency provenance.");
  const cancelled: Plan = { ...plan, step: "cancelled" };
  return save(input, owner, plan, revision, true)
    .flatMap((claimed) =>
      DeviceState.finishStack(input.paths, owner.launchId, plan.id, claimed.revision, {
        state: "cancelled",
        data: JSON.stringify(cancelled),
        base: JSON.stringify({
          head: plan.target,
          branch: plan.base,
          managed: plan.managed,
          parents: plan.parents,
        }),
        relay: JSON.stringify({
          ...stacked(first),
          prerequisites: plan.parents,
          cut: plan.target,
          base: plan.base,
        }),
      }),
    )
    .map(() => ({ reason: "stack_cancelled", data: cancelled }));
}

function cancelStack(input: Input, owner: Owner, id: string): AsyncResult<Outcome, Refusal> {
  return fromPromise(async () => {
    const read = DeviceState.readStack(input.paths, owner.launchId, id);
    if (read.tag !== "Ok") return stop(read);
    const previous = PrStacks.operation(read.value.data);
    const plan = {
      ...previous,
      launchId: owner.launchId,
      previousOwners:
        previous.launchId === owner.launchId
          ? previous.previousOwners
          : [...previous.previousOwners, previous.launchId],
    };
    if (plan.retargetAttempted || plan.step === "complete")
      return refuse(
        "stack_cancel_unsafe",
        "A completed or retarget-attempted refresh cannot be cancelled by guessing its outcome. Preserve the operation and inspect it.",
      );
    if (plan.step === "cancelled") return Ok({ reason: "stack_cancelled", data: plan });
    const child = await childFacts(owner);
    if (child.tag !== "Ok") return stop(child);
    const remote = await pushedHead(owner, plan.remote);
    if (remote.tag !== "Ok") return stop(remote);
    if (
      child.value.base !== plan.base ||
      child.value.head !== remote.value ||
      !(await clean(owner, remote.value))
    )
      return refuse(
        "stack_cancel_unsafe",
        "Cancellation requires a clean, matching local/pushed/observed child and unchanged PR base. No work was discarded.",
      );
    if (plan.candidate === remote.value)
      return cancelInstalled(input, owner, plan, read.value.revision);
    if (remote.value !== plan.head)
      return refuse(
        "stack_cancel_unsafe",
        "The current head is neither recorded child head. No work was discarded.",
      );
    const cancelled: Plan = { ...plan, step: "cancelled" };
    return save(input, owner, cancelled, read.value.revision, false).map(() => ({
      reason: "stack_cancelled",
      data: cancelled,
    }));
  }, qualify).flatMap((result) => result);
}

/** The worktree is the sole target selector; applying again resumes only the same pinned operation. */
export function stack(
  input: Input & {
    action: "plan" | "apply" | "review" | "cancel";
    plan?: string;
    cut?: string;
    parents?: string[];
  },
): AsyncResult<Outcome, Refusal> {
  return resolveOwner({ ...input, stackOperation: true }).flatMap((owner) => {
    if (input.action === "plan") return preview(input, owner);
    if (input.plan === undefined)
      return refuse("stack_plan_required", "Name the pinned stack operation.").toAsync();
    if (input.action === "cancel") return cancelStack(input, owner, input.plan);
    return input.action === "review"
      ? reviewStack(input, owner, input.plan)
      : apply(input, owner, input.plan);
  });
}
