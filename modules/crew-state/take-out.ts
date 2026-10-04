import { and, eq } from "drizzle-orm";
import { IntegrationBranch } from "../integration-branch/main.ts";
import { registerBranchReview, type RegisteredBranchReview } from "./branch-review.ts";
import type { CrewReader, CrewWriter } from "./database.ts";
import { type GateStartResult, startOnStep, startRun } from "./gate-start.ts";
import { fixedGateOf, type IntegrationBranchRow, integrationBranchOf } from "./integration.ts";
import { BranchMove, type LandingRefusal, type MoveNext, type PlanRefusal } from "./branch-move.ts";
import {
  insertLandingIntent,
  intentPlanOf,
  type PlannedMove,
  planOfLanding,
  recordedTipOf,
  writeLandingStates,
} from "./landing.ts";
import {
  currentLandingOf,
  intendedLandingOf,
  type LandingRow,
  rewriteOf,
  type RewriteRecord,
} from "./landing-record.ts";
import { mutate, readState, type RequestFailure, type StateFailure } from "./operations.ts";
import {
  applyRewrite,
  type LaterLanding,
  laterLandings,
  type PlannedRewrite,
  planTakeOutRebuild,
  type RangeGate,
  rangeGateOf,
} from "./rewrite.ts";
import { assignments, integrationBranches, workSources } from "./schema.ts";

/*
 * The take-out of the commits of withdrawn work (ADR 0020). A person withdraws an item through the
 * tracker, and the registration records the withdrawal behind the approval of its plan revision.
 * The branch still holds the commit of that item, so the take-out rebuilds the branch without it,
 * bound to that plan revision (D5). It is a ref move that the CLI builds only from reviewed
 * patches, on a command that the Operator runs, so it is not an Operator change.
 */

/** One withdrawn commit that the integration branch still holds, and the plan that recorded it. */
export type PendingTakeOut = { assignmentId: string; landing: LandingRow; planRevision: string };

/**
 * The plan revision that recorded one withdrawal. Every withdrawal records it, so a withdrawn
 * assignment with none is a broken record, and the command stops on it.
 */
function withdrawnUnderOf(row: { id: string; withdrawnUnder: string | null }): string {
  if (row.withdrawnUnder === null) {
    throw new Error(`Withdrawn assignment ${row.id} records no plan revision.`);
  }
  return row.withdrawnUnder;
}

/**
 * Every withdrawn assignment of one source whose commit the branch still holds, read from the
 * crew state alone. While one is listed, the take-out of the source waits.
 */
export function pendingTakeOutsOf(db: CrewReader, sourceId: string): PendingTakeOut[] {
  return db
    .select()
    .from(assignments)
    .where(and(eq(assignments.sourceId, sourceId), eq(assignments.state, "withdrawn")))
    .all()
    .flatMap((row) => {
      const landing = currentLandingOf(db, row.id);
      return landing === null
        ? []
        : [{ assignmentId: row.id, landing, planRevision: withdrawnUnderOf(row) }];
    })
    .toSorted((left, right) => left.assignmentId.localeCompare(right.assignmentId));
}

/** The withdrawn commits of one source that wait for the take-out, as a blocker names them. */
export function pendingCommitsOf(
  db: CrewReader,
  sourceId: string,
): Array<{ assignmentId: string; commit: string }> {
  return pendingTakeOutsOf(db, sourceId).map((one) => ({
    assignmentId: one.assignmentId,
    commit: one.landing.landedCommit,
  }));
}

/** The command that takes out the withdrawn commits of one source, bound to its plan revision. */
export function takeOutCommand(sourceId: string, planRevision: string): string {
  return `operator work take-out --source ${sourceId} --plan-revision ${planRevision}`;
}

/**
 * The landed commits above one commit of the branch, oldest first, read from the recorded
 * landings with no Git read. They are the commits that a take-out of that commit rebuilds.
 */
export function laterCommitsOf(
  db: CrewReader,
  request: { sourceId: string; commit: string },
): string[] {
  const row = integrationBranchOf(db, request.sourceId);
  if (row === null) {
    return [];
  }
  return (laterLandings(db, { row, replaced: { landedCommit: request.commit } }) ?? []).map(
    (one) => one.commit,
  );
}

/** Why a take-out of one source does nothing now. Each one moves nothing and records nothing. */
export type TakeOutRefusal =
  | { status: "unknown-source"; sourceId: string }
  | { status: "nothing-to-take-out"; sourceId: string }
  | {
      // The take-out is bound to the plan revision that recorded each withdrawal (D5).
      status: "take-out-plan-changed";
      sourceId: string;
      stated: string;
      recorded: string[];
    };

export type TakenOut = {
  status: "taken-out";
  sourceId: string;
  branch: string;
  planRevision: string;
  from: string;
  to: string;
  removed: Array<{ assignmentId: string; commit: string }>;
  relanded: Array<{ assignmentId: string; from: string; to: string }>;
  takenOut: Array<{ assignmentId: string; commit: string; cause: string }>;
  // The branch review that the take-out registered, because it made the branch final.
  branchReview: RegisteredBranchReview | null;
};

export type TakeOutResult =
  | TakenOut
  | TakeOutRefusal
  | PlanRefusal
  | Extract<
      LandingRefusal,
      {
        status:
          | "landing-gate-not-passed"
          | "landing-pending"
          | "integration-branch-unread"
          | "landing-tip-changed";
      }
    >
  | { status: "take-out-intended"; landingId: string };

type Located = { projectRoot: string };

/**
 * The take-out part of one recorded take-out intent. Every take-out intent records it, so an
 * intent with none is a broken record, and the command stops on it.
 */
export function takeOutOf(intent: LandingRow): {
  rewrite: RewriteRecord;
  takeOut: NonNullable<RewriteRecord["takeOut"]>;
} {
  const rewrite = rewriteOf(intent);
  if (rewrite?.takeOut == null) {
    throw new Error(`Take-out intent ${intent.id} records no take-out plan.`);
  }
  return { rewrite, takeOut: rewrite.takeOut };
}

/** The assignment and the plan revision that a take-out of one source names first. */
type Lead = { assignmentId: string; planRevision: string };

/**
 * What a take-out of one source reads first: its branch, its pending commits, its intent, and the
 * plan revisions that recorded them. A take-out in flight is bound to the revision of its intent.
 */
function readTakeOut(
  db: CrewReader,
  sourceId: string,
):
  | Exclude<TakeOutRefusal, { status: "take-out-plan-changed" }>
  | {
      status: "ready";
      row: IntegrationBranchRow;
      pending: PendingTakeOut[];
      intended: LandingRow | null;
      lead: Lead;
      recorded: string[];
    } {
  if (db.select().from(workSources).where(eq(workSources.id, sourceId)).all().length === 0) {
    return { status: "unknown-source", sourceId };
  }
  const pending = pendingTakeOutsOf(db, sourceId);
  const intended = intendedLandingOf(db, sourceId);
  const own: Lead | null =
    intended?.kind === "take-out"
      ? {
          assignmentId: intended.assignmentId,
          planRevision: takeOutOf(intended).takeOut.planRevision,
        }
      : null;
  const row = integrationBranchOf(db, sourceId);
  const lead = pending[0] ?? own;
  if (row === null || lead === null) {
    return { status: "nothing-to-take-out", sourceId };
  }
  const recorded = [
    ...new Set(own === null ? pending.map((one) => one.planRevision) : [own.planRevision]),
  ].toSorted();
  return { status: "ready", row, pending, intended, lead, recorded };
}

/** The read of a take-out that the person runs, bound to the plan revision it states (D5). */
function readBound(db: CrewReader, request: { sourceId: string; planRevision: string }) {
  const read = readTakeOut(db, request.sourceId);
  if (read.status === "ready" && read.recorded.some((one) => one !== request.planRevision)) {
    return {
      status: "take-out-plan-changed" as const,
      sourceId: request.sourceId,
      stated: request.planRevision,
      recorded: read.recorded,
    };
  }
  return read;
}

/**
 * The branch order of the withdrawn commits of one source: the lowest one that the branch holds
 * with no result that is not withdrawn is the replaced one, and each other one leaves with it.
 * Null when every withdrawn commit shares its commit with a result that is not withdrawn.
 */
function lowestWithdrawn(chain: LaterLanding[], pending: PendingTakeOut[]): LandingRow | null {
  const ids = new Set(pending.map((one) => one.landing.id));
  const lowest = chain.find((one) => one.rows.every((landing) => ids.has(landing.id)));
  return lowest?.rows[0] ?? null;
}

/** One planned take-out: the rebuild of the branch, or null when no commit leaves the branch. */
type PlannedTakeOut = {
  status: "planned";
  row: IntegrationBranchRow;
  lead: Lead;
  rebuild: { rewrite: PlannedRewrite; replaced: LandingRow } | null;
  pending: PendingTakeOut[];
};

/**
 * Plans the take-out of every withdrawn commit of one source (ADR 0020), as the rewrite with no
 * replacement. A withdrawn landing that shares its commit with a result that is not withdrawn
 * leaves the record only, because that commit stays. Recorded landings that do not lead from the
 * recorded tip to the base refuse, as a rewrite does. A refusal moves nothing.
 */
async function planTakeOut(request: {
  projectRoot: string;
  sourceId: string;
}): Promise<
  | PlannedTakeOut
  | Exclude<TakeOutRefusal, { status: "take-out-plan-changed" }>
  | PlanRefusal
  | StateFailure
> {
  const read = await readState(request.projectRoot, (db) => {
    const found = readTakeOut(db, request.sourceId);
    return found.status === "ready"
      ? {
          ...found,
          chain: laterLandings(db, {
            row: found.row,
            replaced: { landedCommit: found.row.baseCommit },
          }),
        }
      : found;
  });
  if (read.status !== "ready") {
    return read;
  }
  const { row, lead, pending, chain } = read;
  if (chain === null) {
    return {
      status: "integration-branch-unread",
      assignmentId: lead.assignmentId,
      branch: row.name,
      detail: `The recorded landings of ${row.name} do not lead from ${row.recordedTip} to ${row.baseCommit}.`,
    };
  }
  const replaced = lowestWithdrawn(chain, pending);
  if (replaced === null) {
    return { status: "planned", row, lead, rebuild: null, pending };
  }
  const planned = await planTakeOutRebuild({
    projectRoot: request.projectRoot,
    row,
    replaced,
    withdrawn: pending.map((one) => one.landing),
    planRevision: lead.planRevision,
  });
  if (planned.status !== "planned") {
    return planned;
  }
  return { status: "planned", row, lead, rebuild: { rewrite: planned.rewrite, replaced }, pending };
}

/** Where the take-out of one source stands, as `crew next` reads it. */
export type TakeOutRead = { planRevision: string; gate: RangeGate | null };

/**
 * Plans the take-out of every source that waits for one, so `crew next` can offer its gate runs
 * and the command. The plan writes only Git objects that no ref names. A plan that is refused is
 * left to the command, which names the refusal.
 */
export async function readTakeOuts(projectRoot: string): Promise<Map<string, TakeOutRead>> {
  const reads = new Map<string, TakeOutRead>();
  const sources = await readState(projectRoot, (db) =>
    db
      .select()
      .from(workSources)
      .all()
      .filter(
        (one) => pendingTakeOutsOf(db, one.id).length > 0 && intendedLandingOf(db, one.id) === null,
      )
      .map((one) => one.id),
  );
  if (!Array.isArray(sources)) {
    return reads;
  }
  for (const sourceId of sources) {
    const planned = await planTakeOut({ projectRoot, sourceId });
    if (planned.status !== "planned") {
      continue;
    }
    const { rebuild } = planned;
    const gated =
      rebuild === null
        ? null
        : await readState(projectRoot, (db) => ({ gate: rangeGateOf(db, rebuild.rewrite) }));
    if (gated !== null && !("gate" in gated)) {
      continue;
    }
    reads.set(sourceId, { planRevision: planned.lead.planRevision, gate: gated?.gate ?? null });
  }
  return reads;
}

type TakeOutCall = Located & {
  requestId: string;
  ownerToken: string;
  sourceId: string;
  planRevision: string;
};

type Reported = { repeated: boolean; result: TakeOutResult | StateFailure | RequestFailure };

/**
 * The record of one finished take-out, in the transaction that moves the recorded tip: the next
 * state of each landing that the move ended, each later landing that landed again or returns to
 * awaiting review, and the branch review that the final branch registers.
 */
function recordTakeOut(
  db: CrewWriter,
  request: {
    sourceId: string;
    move: { branch: string; from: string; to: string };
    next: MoveNext;
    rewrite: RewriteRecord | null;
    removed: Array<{ assignmentId: string; commit: string }>;
    planRevision: string;
    now: string;
  },
): TakenOut {
  const { move, rewrite, now } = request;
  writeLandingStates(db, { landings: request.next.landings, now });
  if (rewrite !== null) {
    applyRewrite(db, { rewrite, now });
  }
  db.update(integrationBranches)
    .set({ recordedTip: move.to, updatedAt: now })
    .where(eq(integrationBranches.sourceId, request.sourceId))
    .run();
  return {
    status: "taken-out",
    sourceId: request.sourceId,
    branch: move.branch,
    planRevision: request.planRevision,
    from: move.from,
    to: move.to,
    removed: request.removed,
    relanded: (rewrite?.relanded ?? []).map(({ assignmentId, from, to }) => ({
      assignmentId,
      from,
      to,
    })),
    takenOut: (rewrite?.takenOut ?? []).map(({ assignmentId, commit, cause }) => ({
      assignmentId,
      commit,
      cause,
    })),
    // The take-out that makes the branch final registers its branch review (ADR 0017).
    branchReview: registerBranchReview(db, { sourceId: request.sourceId, now }),
  };
}

/** One write of a take-out under one request identity. A refusal inside it records nothing. */
function writeOnce(
  request: TakeOutCall,
  suffix: string,
  input: unknown,
  body: (db: CrewWriter, now: string) => TakeOutResult,
): Promise<Reported> {
  return mutate(
    {
      projectRoot: request.projectRoot,
      requestId: `${request.requestId}${suffix}`,
      ownerToken: request.ownerToken,
      now: new Date().toISOString(),
      operation: suffix === "" ? "work_take_out" : "work_take_out_landing",
      input,
    },
    ({ tx, now }) => {
      const outcome = body(tx, now);
      // Only the intent and the outcome are written. Every refusal records nothing.
      return {
        commit:
          outcome.status === "taken-out" ||
          (outcome.status === "take-out-intended" && suffix !== ""),
        outcome,
      };
    },
  );
}

/**
 * The request input of the intent of one take-out. Earlier releases hashed the plan with the
 * tree of the move in it, so the identity of a recorded intent request stays the same.
 */
export function takeOutIntentInput(
  request: { sourceId: string; planRevision: string },
  landing: PlannedMove,
) {
  return {
    sourceId: request.sourceId,
    planRevision: request.planRevision,
    plan: intentPlanOf(landing),
  };
}

/** Moves the branch for one recorded take-out intent, then records the outcome. */
async function settle(request: TakeOutCall, intent: LandingRow): Promise<Reported> {
  const plan = planOfLanding(intent);
  const { rewrite, takeOut } = takeOutOf(intent);
  const moved = await IntegrationBranch.move({
    repoRoot: request.projectRoot,
    name: plan.name,
    from: plan.from,
    to: plan.to,
  });
  const decided = BranchMove.decide("take-out", {
    moved,
    place: {
      assignmentId: intent.assignmentId,
      branch: plan.name,
      recordedTip: plan.from,
      tip: plan.from,
      commit: plan.to,
    },
    landingId: intent.id,
    rewrite,
    pending: [],
  });
  if ("refused" in decided) {
    return { repeated: false, result: decided.refused };
  }
  return writeOnce(
    request,
    "",
    { sourceId: request.sourceId, planRevision: request.planRevision },
    (db, now) => {
      const open = intendedLandingOf(db, request.sourceId);
      if (open?.id !== intent.id) {
        return { status: "nothing-to-take-out", sourceId: request.sourceId };
      }
      return recordTakeOut(db, {
        sourceId: request.sourceId,
        move: { branch: plan.name, from: plan.from, to: plan.to },
        next: decided.next,
        rewrite,
        // The intent names the replaced landing, so its assignment is the one the intent names.
        removed: [
          { assignmentId: intent.assignmentId, commit: rewrite.replacedCommit },
          ...takeOut.removed.map(({ assignmentId, commit }) => ({ assignmentId, commit })),
        ],
        planRevision: takeOut.planRevision,
        now,
      });
    },
  );
}

/**
 * Records a take-out that moves no commit, because a result that is not withdrawn shares each
 * withdrawn commit. Only the record of each withdrawn landing ends, on the recorded tip it planned.
 */
function recordOnly(request: TakeOutCall, planned: PlannedTakeOut): Promise<Reported> {
  const { row, lead } = planned;
  const input = { sourceId: request.sourceId, planRevision: request.planRevision };
  return writeOnce(request, "", input, (db, now) => {
    const recordedTip = recordedTipOf(db, request.sourceId);
    if (recordedTip !== row.recordedTip) {
      return {
        status: "landing-tip-changed",
        assignmentId: lead.assignmentId,
        planned: row.recordedTip,
        recordedTip,
      };
    }
    const pending = pendingTakeOutsOf(db, request.sourceId);
    const place = {
      assignmentId: lead.assignmentId,
      branch: row.name,
      recordedTip: row.recordedTip,
      tip: row.recordedTip,
      commit: row.recordedTip,
    };
    const decided = BranchMove.decide("take-out", {
      moved: { status: "moved" },
      place,
      landingId: null,
      rewrite: null,
      pending: pending.map((one) => one.landing.id),
    });
    if ("refused" in decided) {
      return decided.refused;
    }
    return recordTakeOut(db, {
      sourceId: request.sourceId,
      move: { branch: row.name, from: row.recordedTip, to: row.recordedTip },
      next: decided.next,
      rewrite: null,
      removed: pending.map((one) => ({
        assignmentId: one.assignmentId,
        commit: one.landing.landedCommit,
      })),
      planRevision: lead.planRevision,
      now,
    });
  });
}

/**
 * Takes out every withdrawn commit of one source that its integration branch still holds (ADR
 * 0020). The take-out is bound to the plan revision that recorded the withdrawals (D5). Each
 * commit of the rebuilt range passes the project gate first (ADR 0021), then the intent is
 * recorded, the branch moves once from the recorded tip, and the outcome is recorded. A later
 * accepted result that does not land again returns to awaiting review. A refusal before the move
 * moves nothing and records nothing, and an interrupted move is settled by a repeat.
 */
export async function takeOutWithdrawn(request: TakeOutCall): Promise<Reported> {
  const input = { sourceId: request.sourceId, planRevision: request.planRevision };
  // A repeat of a recorded take-out returns its outcome.
  const probed = await writeOnce(request, "", input, (db) => {
    const read = readBound(db, request);
    return read.status === "ready" ? { status: "take-out-intended", landingId: "" } : read;
  });
  if (probed.repeated || probed.result.status !== "take-out-intended") {
    return probed;
  }

  const read = await readState(request.projectRoot, (db) => readBound(db, request));
  if (read.status !== "ready") {
    return { repeated: false, result: read };
  }
  if (read.intended !== null) {
    if (read.intended.kind === "take-out") {
      return settle(request, read.intended);
    }
    return {
      repeated: false,
      result: {
        status: "landing-pending",
        assignmentId: read.intended.assignmentId,
        landingId: read.intended.id,
        pendingAssignmentId: read.intended.assignmentId,
      },
    };
  }

  const planned = await planTakeOut(request);
  if (planned.status !== "planned") {
    return { repeated: false, result: planned };
  }
  // A withdrawn landing on a commit that a live result shares leaves the record only.
  if (planned.rebuild === null) {
    return recordOnly(request, planned);
  }
  const { rewrite, replaced } = planned.rebuild;
  const gated = await readState(request.projectRoot, (db) => ({ gate: rangeGateOf(db, rewrite) }));
  if (!("gate" in gated)) {
    return { repeated: false, result: gated };
  }
  const { gate } = gated;
  if (gate.status !== "passed") {
    return {
      repeated: false,
      result: {
        status: "landing-gate-not-passed",
        assignmentId: replaced.assignmentId,
        gate: `gate_${gate.status}`,
        commit: gate.commit,
        tip: gate.parent,
        key: gate.key,
        runIds: gate.runIds,
      },
    };
  }

  const { plan } = rewrite.landing;
  const landingId = crypto.randomUUID();
  const intended = await writeOnce(
    request,
    ":landing",
    takeOutIntentInput(request, rewrite.landing),
    (db, now) => {
      const open = intendedLandingOf(db, request.sourceId);
      if (open !== null) {
        return {
          status: "landing-pending",
          assignmentId: open.assignmentId,
          landingId: open.id,
          pendingAssignmentId: open.assignmentId,
        };
      }
      const recordedTip = recordedTipOf(db, request.sourceId);
      if (recordedTip !== plan.from) {
        return {
          status: "landing-tip-changed",
          assignmentId: replaced.assignmentId,
          planned: plan.from,
          recordedTip,
        };
      }
      insertLandingIntent(db, {
        landingId,
        sourceId: request.sourceId,
        assignmentId: replaced.assignmentId,
        submissionId: replaced.submissionId,
        plan,
        now,
      });
      return { status: "take-out-intended", landingId };
    },
  );
  if (intended.result.status !== "take-out-intended") {
    return intended;
  }
  const intent = await readState(request.projectRoot, (db) => ({
    row: intendedLandingOf(db, request.sourceId),
  }));
  if (!("row" in intent)) {
    return { repeated: false, result: intent };
  }
  if (intent.row === null) {
    return {
      repeated: false,
      result: { status: "nothing-to-take-out", sourceId: request.sourceId },
    };
  }
  return settle(request, intent.row);
}

/**
 * Starts one gate run on the first commit of the rebuilt range of the take-out of one source
 * whose key has no passing run (ADR 0021). The plan gives the same commits again, so no ref
 * names them. A range that already passed starts nothing.
 */
export async function startTakeOutGateRun(request: {
  projectRoot: string;
  requestId: string;
  ownerToken: string;
  sourceId: string;
  approvalId: string | null;
  runnerLine: (runId: string) => string;
}): Promise<
  | GateStartResult
  | Exclude<TakeOutRefusal, { status: "take-out-plan-changed" }>
  | PlanRefusal
  | StateFailure
> {
  const planned = await planTakeOut(request);
  if (planned.status !== "planned") {
    return planned;
  }
  const { row } = planned;
  const rewrite = planned.rebuild?.rewrite ?? null;
  // A take-out that leaves only the record rebuilds no range, so it has no commit to gate.
  if (rewrite === null) {
    return {
      status: "nothing-to-gate",
      commit: row.recordedTip,
      declarationIdentity: row.gateIdentity,
    };
  }
  const gated = await readState(request.projectRoot, (db) => ({ gate: rangeGateOf(db, rewrite) }));
  if (!("gate" in gated)) {
    return gated;
  }
  return startOnStep({
    step: gated.gate,
    passed: {
      commit: rewrite.landing.plan.to,
      declarationIdentity: row.gateIdentity,
      tree: rewrite.gated.at(-1)?.tree ?? null,
    },
    range: "the rebuilt range",
    start: (gate) =>
      startRun({
        ...request,
        target: {
          sourceId: request.sourceId,
          commit: gate.commit,
          key: gate.key,
          commands: fixedGateOf(row).commands,
          subject: {
            kind: "take-out",
            sourceId: request.sourceId,
            tip: row.recordedTip,
            parent: gate.parent,
          },
          checkoutBase: row.baseCommit,
        },
      }),
  });
}
