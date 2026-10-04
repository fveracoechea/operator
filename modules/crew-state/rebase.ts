import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { IntegrationBranch } from "../integration-branch/main.ts";
import { PullRequestStack } from "../pull-request-stack/main.ts";
import { approvedPlan, REBASE_ACTION } from "./approvals.ts";
import { type RegisteredBranchReview, registerBranchReview } from "./branch-review.ts";
import { BranchMove, type MoveNext, type MoveRefusal } from "./branch-move.ts";
import type { CrewReader, CrewWriter } from "./database.ts";
import { type GateKey, type GateStep, gateStepOf } from "./gate-runs.ts";
import { type GateStartResult, startOnStep, startRun } from "./gate-start.ts";
import { identityOf } from "./identity.ts";
import { fixedGateOf, type IntegrationBranchRow, integrationBranchOf } from "./integration.ts";
import { writeLandingStates } from "./landing.ts";
import {
  currentLandingOf,
  intendedLandingOf,
  type LandingRow,
  takeOutCauseSchema,
} from "./landing-record.ts";
import { mutate, readState, type RequestFailure, type StateFailure } from "./operations.ts";
import { type ApprovalRequest, openPublicationOf } from "./publish.ts";
import { publishedPartsOf, replacedPullsOf } from "./publish-status.ts";
import {
  laterLandings,
  refusedTrees,
  relandAll,
  returnTakenOut,
  trackerHold,
  withNeeds,
} from "./rewrite.ts";
import { assignments, integrationBranches, integrationRebases, workSources } from "./schema.ts";
import { repositoryOf } from "./stack-records.ts";
import { readStored } from "./stored.ts";

const PLAN_STORE = ".operator/local/rebase-plans";

/**
 * What one rebase does to each landing of its source, as its intent records it, so recovery and
 * the outcome read the same move. A merged landing leaves the branch, a relanded one names its new
 * commit and parent, and a taken-out one names its cause.
 */
const rebaseRecordSchema = z.strictObject({
  merged: z.array(
    z.strictObject({ landingId: z.string(), assignmentId: z.string(), commit: z.string() }),
  ),
  relanded: z.array(
    z.strictObject({
      landingId: z.string(),
      assignmentId: z.string(),
      from: z.string(),
      to: z.string(),
      parent: z.string(),
    }),
  ),
  takenOut: z.array(
    z.strictObject({
      landingId: z.string(),
      assignmentId: z.string(),
      commit: z.string(),
      cause: takeOutCauseSchema,
    }),
  ),
});

export type RebaseRecord = z.infer<typeof rebaseRecordSchema>;

type RebaseRow = typeof integrationRebases.$inferSelect;

/** Why the target branch cannot be read, as the stack names it for a plan and for a rebase. */
type TargetReason = Extract<
  Awaited<ReturnType<typeof PullRequestStack.target>>,
  { status: "unread" }
>["reason"];

/**
 * The refusals of a rebase plan, members of the durable unions of ADR 0011. Each one moves
 * nothing and records nothing, and a plan reports every one it finds at once.
 */
export type RebaseRefusal = {
  reason:
    | "integration_branch_missing"
    | "integration_branch_moved"
    | "integration_branch_checked_out"
    | "integration_branch_unread"
    | "landing_pending"
    | "rebase_pending"
    | "publish_unsettled"
    | "rebase_published_range"
    | "rebase_correction_open"
    | "rebase_take_out_pending"
    | TargetReason
    | "rebase_base_not_on_target"
    | "rebase_base_unchanged"
    | "rebase_base_not_ahead"
    | "rebase_merge_not_in_base"
    | "rewrite_tracker_recorded";
  detail: string;
};

/** One commit the project gate runs on before the branch moves: the new base, then each commit. */
export type RebasePlace = { commit: string; parent: string | null; key: GateKey };

/** Where the project gate stands on a rebase: the first place that has not passed. */
export type RebaseGate = GateStep<RebasePlace>;

type Move = { base: string; tip: string };

/**
 * One rebase plan: refused, with each refusal and what the plan could read, or ready, with the
 * revision and the approval that binds it. A ready plan has no refusal.
 */
type UnwrittenPreview = {
  status: "planned";
  sourceId: string;
  target: { name: string; tip: string } | null;
  refusals: RebaseRefusal[];
} & (
  | {
      places: RebasePlace[];
      branch: string | null;
      planRevision: null;
      from: Move | null;
      to: Move | null;
      record: RebaseRecord | null;
      gate: RebaseGate | null;
      approval: null;
    }
  | {
      /** The new base, then each commit that lands again. */
      places: [RebasePlace, ...RebasePlace[]];
      branch: string;
      planRevision: string;
      from: Move;
      to: Move;
      record: RebaseRecord;
      gate: RebaseGate;
      approval: ApprovalRequest;
    }
);

export type RebasePreview = UnwrittenPreview & { planPath: string };

/**
 * The plan revision of one rebase: the source, the branch, its old base and tip, and the new base.
 * It reads no Git, so `crew next` can tell whether an approval names the plan of today.
 */
export function rebaseRevisionOf(request: {
  sourceId: string;
  branch: string;
  from: { base: string; tip: string };
  newBase: string;
}): string {
  return identityOf(request);
}

/** The rebase of one source whose move has no recorded outcome, or null. */
export function intendedRebaseOf(db: CrewReader, sourceId: string): RebaseRow | null {
  return (
    db
      .select()
      .from(integrationRebases)
      .where(
        and(eq(integrationRebases.sourceId, sourceId), eq(integrationRebases.state, "intended")),
      )
      .all()[0] ?? null
  );
}

export function rebaseRecordOf(row: RebaseRow): RebaseRecord {
  return readStored("rebase plan", rebaseRecordSchema, row.plan);
}

/**
 * The refusals that the crew records decide. A rebase is allowed before publish, or after a
 * recall or a stack fault, and never while a published pull request is open, because a person may
 * still read and merge what it holds (decision 25). No recall is recorded yet, so an open
 * published pull request refuses, also one with a fault that no person settled. Once the person
 * settled every fault, the open parts are stopped, and the next publication replaces them.
 */
function recordRefusals(
  db: CrewReader,
  request: { sourceId: string; row: IntegrationBranchRow },
): RebaseRefusal[] {
  const { sourceId, row } = request;
  const refusals: RebaseRefusal[] = [];
  const landing = intendedLandingOf(db, sourceId);
  if (landing !== null) {
    refusals.push({
      reason: "landing_pending",
      detail: `Landing ${landing.id} of assignment ${landing.assignmentId} moves ${row.name}, and its outcome is not recorded. Settle it first.`,
    });
  }
  const rebase = intendedRebaseOf(db, sourceId);
  if (rebase !== null) {
    refusals.push({
      reason: "rebase_pending",
      detail: `Rebase ${rebase.id} moves ${row.name} onto ${rebase.toBase}, and its outcome is not recorded. Repeat it with plan revision ${rebase.planRevision}.`,
    });
  }
  const unsettled = openPublicationOf(db, sourceId);
  if (unsettled !== null) {
    refusals.push({
      reason: "publish_unsettled",
      detail: `Stack publication ${unsettled.publication.number} holds a write with no done outcome. Settle it first.`,
    });
  }
  // A person settled every fault of an ended publication, so its open pull requests are stopped:
  // the next stack publication carries their commits and closes each one (decision 23).
  const replaced = new Set(replacedPullsOf(db, sourceId).map((one) => one.number));
  const open = publishedPartsOf(db, sourceId).open.filter(
    (one) => one.number === null || !replaced.has(one.number),
  );
  if (open.length > 0) {
    refusals.push({
      reason: "rebase_published_range",
      detail: `Pull request(s) ${open.map((one) => `#${one.number ?? "?"}${one.fault === null ? "" : ` (stack fault ${one.fault})`}`).join(", ")} of this source are open on GitHub, and no recall is recorded. A rebase never changes what an open pull request holds. A person closes each one, and the next stack publication replaces it.`,
    });
  }
  const production = db
    .select()
    .from(assignments)
    .where(and(eq(assignments.sourceId, sourceId), eq(assignments.kind, "production")))
    .all();
  // A correction takes the place of its landed commit, so the branch moves under it only after it.
  const correcting = production.filter(
    (one) =>
      one.state !== "accepted" &&
      one.state !== "withdrawn" &&
      currentLandingOf(db, one.id) !== null,
  );
  if (correcting.length > 0) {
    refusals.push({
      reason: "rebase_correction_open",
      detail: `Assignment(s) ${correcting.map((one) => `${one.id} (${one.state})`).join(", ")} hold a landed commit that a correction replaces. Accept the correction first.`,
    });
  }
  const withdrawn = production.filter(
    (one) => one.state === "withdrawn" && currentLandingOf(db, one.id)?.state === "landed",
  );
  if (withdrawn.length > 0) {
    refusals.push({
      reason: "rebase_take_out_pending",
      detail: `The branch still holds the commit of withdrawn assignment(s) ${withdrawn.map((one) => one.id).join(", ")}. Take it out first.`,
    });
  }
  return refusals;
}

/** The refusal one refused module plan gives. */
function moduleRefusal(
  row: IntegrationBranchRow,
  plan: Exclude<Awaited<ReturnType<typeof IntegrationBranch.rebase>>, { status: "ready" }>,
): RebaseRefusal {
  switch (plan.status) {
    case "tip-moved":
      return {
        reason: "integration_branch_moved",
        detail: `The branch ${row.name} holds ${plan.found ?? "no commit"}, and the recorded tip is ${row.recordedTip}. The person puts it back.`,
      };
    case "checked-out":
      return {
        reason: "integration_branch_checked_out",
        detail: `The branch ${row.name} is checked out in ${plan.worktrees.join(", ")}.`,
      };
    case "base-unchanged":
      return {
        reason: "rebase_base_unchanged",
        detail: `The integration base of ${row.name} is already ${row.baseCommit}.`,
      };
    case "base-not-ahead":
      return {
        reason: "rebase_base_not_ahead",
        detail: `The integration base ${plan.base} is not an ancestor of ${plan.newBase}, so the base would not move forward along the target.`,
      };
    case "merge-not-in-base":
      return {
        reason: "rebase_merge_not_in_base",
        detail: `The merge commit ${plan.mergeCommit} of a pull request of this source is not in ${plan.newBase}, so its commits cannot leave the branch.`,
      };
    default:
      return { reason: "integration_branch_unread", detail: plan.detail };
  }
}

/** The landing records of one module plan, by the landing rows of each commit. */
function recordOf(
  plan: Extract<Awaited<ReturnType<typeof IntegrationBranch.rebase>>, { status: "ready" }>,
  rowsOf: Map<string, LandingRow[]>,
): RebaseRecord {
  const rows = (commit: string) => rowsOf.get(commit) ?? [];
  return {
    merged: plan.merged.flatMap((commit) =>
      rows(commit).map((one) => ({ landingId: one.id, assignmentId: one.assignmentId, commit })),
    ),
    relanded: plan.relanded.flatMap((moved) =>
      rows(moved.was).map((one) => ({
        landingId: one.id,
        assignmentId: one.assignmentId,
        from: moved.was,
        to: moved.commit,
        parent: moved.parent,
      })),
    ),
    takenOut: plan.takenOut.flatMap((out) =>
      rows(out.commit).map((one) => ({
        landingId: one.id,
        assignmentId: one.assignmentId,
        commit: out.commit,
        cause: out.cause,
      })),
    ),
  };
}

/** The full plan, written to a local file, while the command report stays a summary (R5). */
function previewText(preview: UnwrittenPreview): string {
  const line = (label: string, values: string[]) =>
    values.length === 0
      ? [`- ${label}: none`]
      : [`- ${label}:`, ...values.map((one) => `  - ${one}`)];
  const { record } = preview;
  return [
    `# Rebase plan ${preview.planRevision ?? "(refused)"}`,
    "",
    `- Source: ${preview.sourceId}`,
    `- Branch: ${preview.branch ?? "none"}`,
    `- Old base and tip: ${preview.from === null ? "none" : `${preview.from.base}, ${preview.from.tip}`}`,
    `- New base and tip: ${preview.to === null ? "none" : `${preview.to.base}, ${preview.to.tip}`}`,
    `- Target: ${preview.target === null ? "unread" : `${preview.target.name} at ${preview.target.tip}`}`,
    ...line(
      "Leave the branch, because their pull request merged",
      (record?.merged ?? []).map((one) => `${one.commit} (assignment ${one.assignmentId})`),
    ),
    ...line(
      "Land again with an equal patch",
      (record?.relanded ?? []).map(
        (one) => `${one.from} as ${one.to} on ${one.parent} (assignment ${one.assignmentId})`,
      ),
    ),
    ...line(
      "Taken out, to return to awaiting review and an integration cycle",
      (record?.takenOut ?? []).map(
        (one) => `${one.commit} (${one.cause}, assignment ${one.assignmentId})`,
      ),
    ),
    ...line(
      "Gated before the branch moves, in order",
      preview.places.map((one) => `${one.commit}${one.parent === null ? " (the new base)" : ""}`),
    ),
    "",
    "## Refusals",
    "",
    ...(preview.refusals.length === 0
      ? ["None."]
      : preview.refusals.map((one) => `- ${one.reason}: ${one.detail}`)),
  ].join("\n");
}

/**
 * The new base of a rebase: a fetched tip of the target branch, never a commit only this checkout
 * holds. It gives the target it read, and the one refusal that stops the plan, if any.
 */
async function newBaseOf(request: {
  projectRoot: string;
  sourceId: string;
  newBase: string;
  repository: string | null;
}): Promise<{
  target: RebasePreview["target"];
  newBase: string | null;
  refusal: RebaseRefusal | null;
}> {
  if (request.repository === null) {
    return {
      target: null,
      newBase: null,
      refusal: {
        reason: "repository_unread",
        detail: `Source ${request.sourceId} records no tracker repository, so its target is unknown.`,
      },
    };
  }
  const fetched = await PullRequestStack.target({
    repoRoot: request.projectRoot,
    repository: request.repository,
    commit: request.newBase,
  });
  if (fetched.status !== "read") {
    return {
      target: null,
      newBase: null,
      refusal: { reason: fetched.reason, detail: fetched.detail },
    };
  }
  const target = { name: fetched.target, tip: fetched.tip };
  const resolved = await IntegrationBranch.resolve({
    repoRoot: request.projectRoot,
    commit: request.newBase,
  });
  return fetched.onTarget && resolved.status === "resolved"
    ? { target, newBase: resolved.commit, refusal: null }
    : {
        target,
        newBase: null,
        refusal: {
          reason: "rebase_base_not_on_target",
          detail: `Commit ${request.newBase} is not on ${fetched.target} at its fetched tip ${fetched.tip}.`,
        },
      };
}

/**
 * Plans the rebase of the integration branch of one source onto a new base, and changes nothing
 * that others read: no crew state and no ref, only Git objects (ADR 0022, decision 25). The new
 * base must be on the fetched target. The plan revision names the source, the branch, the old
 * base and tip, and the new base, so a gate run between the plan and the apply keeps it.
 */
export async function planRebase(request: {
  projectRoot: string;
  sourceId: string;
  newBase: string;
}): Promise<RebasePreview | StateFailure | { status: "unknown-source"; sourceId: string }> {
  const read = await readState(request.projectRoot, (db) => {
    const source = db.select().from(workSources).where(eq(workSources.id, request.sourceId)).all();
    const row = integrationBranchOf(db, request.sourceId);
    if (source[0] === undefined || row === null) {
      return { kind: "missing" as const, source: source[0] ?? null, row };
    }
    const chain = laterLandings(db, { row, replaced: { landedCommit: row.baseCommit } });
    return {
      kind: "read" as const,
      source: source[0],
      row,
      refusals: recordRefusals(db, { sourceId: request.sourceId, row }),
      chain: chain === null ? null : withNeeds(db, chain),
      refused: refusedTrees(db, row),
      parts: publishedPartsOf(db, request.sourceId),
      repository: repositoryOf(db, request.sourceId),
    };
  });
  if ("status" in read) {
    return read;
  }
  if (read.source === null) {
    return { status: "unknown-source", sourceId: request.sourceId };
  }
  const empty = {
    status: "planned" as const,
    sourceId: request.sourceId,
    branch: read.row?.name ?? null,
    planRevision: null,
    from: read.row === null ? null : { base: read.row.baseCommit, tip: read.row.recordedTip },
    to: null,
    target: null,
    record: null,
    places: [],
    gate: null,
    approval: null,
  };
  const finish = async (preview: UnwrittenPreview): Promise<RebasePreview> => {
    const name = preview.planRevision ?? `refused-${identityOf(preview).slice(0, 16)}`;
    const planPath = `${PLAN_STORE}/${name}.md`;
    await Bun.write(`${request.projectRoot}/${planPath}`, `${previewText(preview)}\n`, {
      createPath: true,
    });
    return { ...preview, planPath };
  };
  if (read.kind === "missing") {
    return finish({
      ...empty,
      refusals: [
        {
          reason: "integration_branch_missing",
          detail: `Source ${request.sourceId} records no integration branch, so it has no base to move.`,
        },
      ],
    });
  }
  const { row, chain } = read;
  const refusals = [...read.refusals];
  if (chain === null) {
    refusals.push({
      reason: "integration_branch_unread",
      detail: `The recorded landings of ${row.name} do not lead from ${row.recordedTip} to ${row.baseCommit}.`,
    });
  }
  const { target, newBase, refusal } = await newBaseOf({
    ...request,
    repository: read.repository,
  });
  if (refusal !== null) {
    refusals.push(refusal);
  }
  if (chain === null || newBase === null) {
    return finish({ ...empty, target, refusals });
  }

  // A part merged into the target carries every commit below its published commit, bottom up.
  const commits = chain.map((one) => one.commit);
  const mergedParts = read.parts.merged.filter((one) => commits.includes(one.publishedCommit));
  const top = Math.max(-1, ...mergedParts.map((one) => commits.indexOf(one.publishedCommit)));
  const plan = await IntegrationBranch.rebase({
    repoRoot: request.projectRoot,
    name: row.name,
    base: row.baseCommit,
    recordedTip: row.recordedTip,
    newBase,
    commits: chain.map((one, index) => ({
      commit: one.commit,
      needs: one.needs,
      merged: index <= top,
    })),
    mergeCommits: mergedParts.map((one) => one.mergeCommit),
    refused: read.refused,
  });
  if (plan.status !== "ready") {
    return finish({ ...empty, target, refusals: [...refusals, moduleRefusal(row, plan)] });
  }

  const record = recordOf(plan, new Map(chain.map((one) => [one.commit, one.rows])));
  const declarationIdentity = row.gateIdentity;
  const places: [RebasePlace, ...RebasePlace[]] = [
    { commit: newBase, parent: null, key: { tree: plan.base.tree, declarationIdentity } },
    ...plan.relanded.map((one) => ({
      commit: one.commit,
      parent: one.parent,
      key: { tree: one.tree, declarationIdentity },
    })),
  ];
  const gate = await readState(request.projectRoot, (db) => ({
    verdict: gateStepOf(db, places),
    // A result that leaves the branch while a tracker step says it is done waits on a person.
    held: trackerHold(
      db,
      record.takenOut.map((one) => one.assignmentId),
    ),
  }));
  if ("status" in gate) {
    return gate;
  }
  if (gate.held.length > 0) {
    refusals.push({
      reason: "rewrite_tracker_recorded",
      detail: `A tracker step is recorded for ${gate.held.map((one) => `${one.assignmentId} (${one.step} ${one.state})`).join(", ")}, which the rebase would take out. A person decides.`,
    });
  }
  const planned = {
    ...empty,
    to: { base: newBase, tip: plan.to },
    target,
    record,
    places,
    gate: gate.verdict,
    refusals,
  };
  if (refusals.length > 0) {
    return finish(planned);
  }
  const from = { base: row.baseCommit, tip: row.recordedTip };
  const planRevision = rebaseRevisionOf({
    sourceId: request.sourceId,
    branch: row.name,
    from,
    newBase,
  });
  return finish({
    ...planned,
    branch: row.name,
    planRevision,
    from,
    approval: {
      action: REBASE_ACTION,
      targets: [row.baseCommit, newBase],
      scope: request.sourceId,
      requestRevision: planRevision,
    },
  });
}

export type RebaseResult =
  | { status: "refused"; preview: RebasePreview }
  | {
      status: "plan-revision-changed";
      stated: string;
      planned: string | null;
      planPath: string | null;
    }
  | { status: "approval-required"; approval: ApprovalRequest; planPath: string }
  | {
      status: "gate-not-passed";
      gate: Exclude<RebaseGate, { status: "passed" }>;
      preview: RebasePreview;
    }
  | {
      status: "rebased";
      rebaseId: string;
      branch: string;
      from: { base: string; tip: string };
      to: { base: string; tip: string };
      record: RebaseRecord;
      branchReview: RegisteredBranchReview | null;
    }
  | MoveRefusal["rebase"]
  | { status: "rebase-pending"; rebaseId: string; planRevision: string }
  | { status: "unknown-source"; sourceId: string }
  | StateFailure
  | RequestFailure;

type Caller = {
  projectRoot: string;
  requestId: string;
  ownerToken: string;
  sourceId: string;
};

/**
 * Records the outcome of one rebase, in one transaction: the next state of the rebase and of each
 * landing it ended, the new base and tip, each landing that landed again, each assignment whose
 * landing was taken out, and the branch review of the new head, which counts against the limit
 * of three (ADR 0017).
 */
function recordRebased(
  db: CrewWriter,
  request: { rebase: RebaseRow; next: MoveNext; now: string },
): RegisteredBranchReview | null {
  const { rebase, next, now } = request;
  const record = rebaseRecordOf(rebase);
  if (next.rebase !== null) {
    db.update(integrationRebases)
      .set({ state: next.rebase, rebasedAt: now })
      .where(eq(integrationRebases.id, rebase.id))
      .run();
  }
  db.update(integrationBranches)
    .set({ baseCommit: rebase.toBase, recordedTip: rebase.toTip, updatedAt: now })
    .where(eq(integrationBranches.sourceId, rebase.sourceId))
    .run();
  writeLandingStates(db, { landings: next.landings, now });
  relandAll(db, record.relanded);
  returnTakenOut(db, { takenOut: record.takenOut, now });
  return registerBranchReview(db, { sourceId: rebase.sourceId, now });
}

/**
 * Moves the branch for one recorded rebase intent, then records the outcome. Recovery reads the
 * ref once: the old tip moves again, the planned tip records the outcome, and anything else is a
 * moved branch, which keeps the intent open for a person.
 */
async function settle(request: Caller, rebase: RebaseRow): Promise<RebaseResult> {
  const moved = await IntegrationBranch.move({
    repoRoot: request.projectRoot,
    name: rebase.branch,
    from: rebase.fromTip,
    to: rebase.toTip,
  });
  const record = rebaseRecordOf(rebase);
  const decided = BranchMove.decide("rebase", {
    moved,
    rebase,
    merged: record.merged.map((one) => one.landingId),
    takenOut: record.takenOut.map((one) => one.landingId),
  });
  if ("refused" in decided) {
    return decided.refused;
  }
  const { next } = decided;
  const recorded = await mutate(
    {
      projectRoot: request.projectRoot,
      requestId: `${request.requestId}:rebased`,
      ownerToken: request.ownerToken,
      now: new Date().toISOString(),
      operation: "work_rebase_outcome",
      input: { rebaseId: rebase.id },
    },
    ({ tx, now }) => {
      const current = tx
        .select()
        .from(integrationRebases)
        .where(eq(integrationRebases.id, rebase.id))
        .all()[0];
      if (current?.state !== "intended") {
        return { commit: false, outcome: { status: "recorded" as const, branchReview: null } };
      }
      return {
        commit: true,
        outcome: {
          status: "recorded" as const,
          branchReview: recordRebased(tx, { rebase, next, now }),
        },
      };
    },
  );
  if (recorded.result.status !== "recorded") {
    return recorded.result;
  }
  return {
    status: "rebased",
    rebaseId: rebase.id,
    branch: rebase.branch,
    from: { base: rebase.fromBase, tip: rebase.fromTip },
    to: { base: rebase.toBase, tip: rebase.toTip },
    record: rebaseRecordOf(rebase),
    branchReview: recorded.result.branchReview,
  };
}

/**
 * Rebases the integration branch of one source onto a new base, exactly as `planRebase`
 * previewed it, behind one `integration-rebase` approval of its plan revision (decision 25). The
 * new base and each commit that lands again pass the project gate first, in order, so a failing
 * new base is never recorded (ADR 0021). Then the intent is recorded, the branch moves once, and
 * the outcome is recorded. The move is a ref move that the CLI builds only from reviewed patches,
 * on a command that the Operator runs, so it is not an Operator change (D5). It writes no file in
 * any checkout, deletes no branch, and writes nothing to GitHub.
 */
export async function applyRebase(
  request: Caller & { newBase: string; planRevision: string },
): Promise<RebaseResult> {
  const open = await readState(request.projectRoot, (db) => ({
    rebase: intendedRebaseOf(db, request.sourceId),
  }));
  if ("status" in open) {
    return open;
  }
  if (open.rebase !== null) {
    return open.rebase.planRevision === request.planRevision
      ? settle(request, open.rebase)
      : {
          status: "rebase-pending",
          rebaseId: open.rebase.id,
          planRevision: open.rebase.planRevision,
        };
  }

  const planned = await planRebase(request);
  if (planned.status !== "planned") {
    return planned;
  }
  const decided = await approvedPlan(request.projectRoot, planned, request.planRevision);
  if (decided.status === "refused") {
    return { status: "refused", preview: planned };
  }
  if (decided.status !== "approved") {
    return decided;
  }
  const { preview, approvalId } = decided;
  if (preview.gate.status !== "passed") {
    return { status: "gate-not-passed", gate: preview.gate, preview };
  }

  const { from, to, record, branch } = preview;
  const rebaseId = crypto.randomUUID();
  const intended = await mutate<
    { status: "intended"; rebase: RebaseRow } | { status: "tip-changed" }
  >(
    {
      projectRoot: request.projectRoot,
      requestId: request.requestId,
      ownerToken: request.ownerToken,
      now: new Date().toISOString(),
      operation: "work_rebase",
      input: { sourceId: request.sourceId, newBase: to.base, planRevision: request.planRevision },
    },
    ({ tx, now }) => {
      // Another move since the plan changes what the plan rebuilt, so nothing is recorded.
      const row = integrationBranchOf(tx, request.sourceId);
      if (
        row?.recordedTip !== from.tip ||
        row.baseCommit !== from.base ||
        intendedLandingOf(tx, request.sourceId) !== null ||
        intendedRebaseOf(tx, request.sourceId) !== null
      ) {
        return { commit: false, outcome: { status: "tip-changed" as const } };
      }
      const rebase: RebaseRow = {
        id: rebaseId,
        sourceId: request.sourceId,
        planRevision: request.planRevision,
        approvalId,
        branch,
        fromBase: from.base,
        toBase: to.base,
        fromTip: from.tip,
        toTip: to.tip,
        plan: JSON.stringify(record),
        state: "intended",
        createdAt: now,
        rebasedAt: null,
      };
      tx.insert(integrationRebases).values(rebase).run();
      return { commit: true, outcome: { status: "intended" as const, rebase } };
    },
  );
  if (intended.result.status === "tip-changed") {
    return {
      status: "plan-revision-changed",
      stated: request.planRevision,
      planned: null,
      planPath: preview.planPath,
    };
  }
  if (intended.result.status !== "intended") {
    return intended.result;
  }
  return settle(request, intended.result.rebase);
}

export type RebaseGateStart =
  | GateStartResult
  | { status: "rebase-refused"; preview: RebasePreview }
  | {
      status: "rebase-gate-failed";
      gate: Omit<Exclude<RebaseGate, { status: "passed" }>, "status"> & {
        status: "failed" | "flaky";
      };
    }
  | { status: "unknown-source"; sourceId: string };

/**
 * Starts one gate run on the first place of a rebase whose key has not passed: the new base, under
 * the gate declaration fixed on the source, then each commit that lands again, in order (ADR
 * 0021). The plan is made again for each run, so a commit whose new tree failed is taken out by
 * the next plan, and only the changed part is gated again.
 */
export async function startRebaseGateRun(request: {
  projectRoot: string;
  requestId: string;
  ownerToken: string;
  sourceId: string;
  newBase: string;
  approvalId: string | null;
  runnerLine: (runId: string) => string;
}): Promise<RebaseGateStart | StateFailure> {
  const preview = await planRebase(request);
  if (preview.status !== "planned") {
    return preview;
  }
  const read = await readState(request.projectRoot, (db) => ({
    row: integrationBranchOf(db, request.sourceId),
  }));
  if ("status" in read) {
    return read;
  }
  // A ready plan has a gate and a new tip, and only a refused plan has a refusal.
  if (preview.planRevision === null || read.row === null) {
    return { status: "rebase-refused", preview };
  }
  const [base, ...relanded] = preview.places;
  const { key } = relanded.at(-1) ?? base;
  const { row } = read;
  return startOnStep({
    step: preview.gate,
    passed: { commit: preview.to.tip, ...key },
    range: "the rebase",
    start: async (gate) => {
      // Nothing reruns a failed key by itself. Only a person starts a fresh series, with an approval.
      if (gate.status !== "pending" && request.approvalId === null) {
        return { status: "rebase-gate-failed" as const, gate: { ...gate, status: gate.status } };
      }
      return startRun({
        ...request,
        target: {
          sourceId: request.sourceId,
          commit: gate.commit,
          key: gate.key,
          commands: fixedGateOf(row).commands,
          // The new base is gated as a base, so publish reads it as the integration base it becomes.
          subject:
            gate.parent === null
              ? { kind: "base" }
              : { kind: "rebase", base: preview.to.base, parent: gate.parent },
          checkoutBase: gate.commit,
        },
      });
    },
  });
}
