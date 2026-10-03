import { and, eq } from "drizzle-orm";
import { IntegrationBranch } from "../integration-branch/main.ts";
import { registerBranchReview, type RegisteredBranchReview } from "./branch-review.ts";
import type { CrewReader, CrewWriter } from "./database.ts";
import { type GateStartResult, startRun } from "./gate-start.ts";
import { fixedGateOf, type IntegrationBranchRow, integrationBranchOf } from "./integration.ts";
import {
  currentLandingOf,
  insertLandingIntent,
  intendedLandingOf,
  type LandingPlan,
  type LandingRefusal,
  type LandingRow,
  planOfLanding,
  type PlanRefusal,
  recordedTipOf,
  rewriteOf,
} from "./landing.ts";
import { mutate, readState, type RequestFailure, type StateFailure } from "./operations.ts";
import {
  applyRewrite,
  laterLandings,
  type PlannedRewrite,
  planTakeOutRebuild,
  type RangeGate,
  rangeGateOf,
} from "./rewrite.ts";
import { assignments, integrationBranches, landings, workSources } from "./schema.ts";

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
        : [{ assignmentId: row.id, landing, planRevision: row.withdrawnUnder ?? "" }];
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
      { status: "landing-gate-not-passed" | "landing-pending" | "integration-branch-unread" }
    >
  | {
      status: "landing-tip-changed";
      assignmentId: string;
      planned: string;
      recordedTip: string | null;
    }
  | { status: "take-out-intended"; landingId: string };

type Located = { projectRoot: string };

/** What a take-out of one source reads first: its branch, its pending commits, and its intent. */
function readTakeOut(
  db: CrewReader,
  request: { sourceId: string; planRevision: string | null },
):
  | TakeOutRefusal
  | {
      status: "ready";
      row: IntegrationBranchRow;
      pending: PendingTakeOut[];
      intended: LandingRow | null;
    } {
  const { sourceId } = request;
  if (db.select().from(workSources).where(eq(workSources.id, sourceId)).all().length === 0) {
    return { status: "unknown-source", sourceId };
  }
  const pending = pendingTakeOutsOf(db, sourceId);
  const intended = intendedLandingOf(db, sourceId);
  const own = intended !== null && intended.kind === "take-out" ? intended : null;
  const row = integrationBranchOf(db, sourceId);
  if (row === null) {
    return { status: "nothing-to-take-out", sourceId };
  }
  if (pending.length === 0 && own === null) {
    return { status: "nothing-to-take-out", sourceId };
  }
  // A take-out in flight is bound to the revision that its intent recorded.
  const recorded = [
    ...new Set(
      own === null
        ? pending.map((one) => one.planRevision)
        : [rewriteOf(own)?.takeOut?.planRevision ?? ""],
    ),
  ].toSorted();
  if (request.planRevision !== null && recorded.some((one) => one !== request.planRevision)) {
    return {
      status: "take-out-plan-changed",
      sourceId,
      stated: request.planRevision,
      recorded,
    };
  }
  return { status: "ready", row, pending, intended };
}

/**
 * The branch order of the withdrawn commits of one source: the lowest one that the branch holds
 * with no result that is not withdrawn is the replaced one, and each other one leaves with it.
 */
function lowestWithdrawn(
  db: CrewReader,
  request: { row: IntegrationBranchRow; pending: PendingTakeOut[] },
): LandingRow | null {
  const ids = new Set(request.pending.map((one) => one.landing.id));
  const chain = laterLandings(db, {
    row: request.row,
    replaced: { landedCommit: request.row.baseCommit },
  });
  const lowest = chain?.find((one) => one.rows.every((landing) => ids.has(landing.id)));
  return lowest?.rows[0] ?? null;
}

/**
 * Plans the take-out of every withdrawn commit of one source (ADR 0020), as the rewrite with no
 * replacement. A withdrawn landing that shares its commit with a result that is not withdrawn
 * leaves the record only, because that commit stays. A refusal moves nothing.
 */
export async function planTakeOut(request: {
  projectRoot: string;
  sourceId: string;
  planRevision: string | null;
}): Promise<
  | {
      status: "planned";
      row: IntegrationBranchRow;
      planRevision: string;
      rewrite: PlannedRewrite | null;
      pending: PendingTakeOut[];
    }
  | TakeOutRefusal
  | PlanRefusal
  | StateFailure
> {
  const read = await readState(request.projectRoot, (db) => {
    const found = readTakeOut(db, request);
    return found.status === "ready" ? { ...found, replaced: lowestWithdrawn(db, found) } : found;
  });
  if (read.status !== "ready") {
    return read;
  }
  const planRevision = read.pending[0]?.planRevision ?? request.planRevision ?? "";
  if (read.replaced === null) {
    return { status: "planned", row: read.row, planRevision, rewrite: null, pending: read.pending };
  }
  const planned = await planTakeOutRebuild({
    projectRoot: request.projectRoot,
    row: read.row,
    replaced: read.replaced,
    withdrawn: read.pending.map((one) => one.landing),
    planRevision,
  });
  if (planned.status !== "planned") {
    return planned;
  }
  return {
    status: "planned",
    row: read.row,
    planRevision,
    rewrite: planned.rewrite,
    pending: read.pending,
  };
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
    const planned = await planTakeOut({ projectRoot, sourceId, planRevision: null });
    if (planned.status !== "planned") {
      continue;
    }
    const { rewrite } = planned;
    const gated =
      rewrite === null
        ? null
        : await readState(projectRoot, (db) => ({ gate: rangeGateOf(db, rewrite) }));
    if (gated !== null && !("gate" in gated)) {
      continue;
    }
    reads.set(sourceId, { planRevision: planned.planRevision, gate: gated?.gate ?? null });
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

/** The record of one finished take-out, in the transaction that moves the recorded tip. */
function recordTakeOut(
  db: CrewWriter,
  request: {
    sourceId: string;
    landingId: string | null;
    plan: LandingPlan;
    pending: PendingTakeOut[];
    planRevision: string;
    now: string;
  },
): TakenOut {
  const { plan, now } = request;
  const rewrite = plan.rewrite;
  if (request.landingId !== null) {
    db.update(landings)
      .set({ state: "taken-out", landedAt: now })
      .where(eq(landings.id, request.landingId))
      .run();
  }
  if (rewrite !== null) {
    applyRewrite(db, { rewrite, now });
  } else {
    // No commit leaves the branch, so only the record of each withdrawn landing ends.
    for (const one of request.pending) {
      db.update(landings).set({ state: "taken-out" }).where(eq(landings.id, one.landing.id)).run();
    }
  }
  db.update(integrationBranches)
    .set({ recordedTip: plan.to, updatedAt: now })
    .where(eq(integrationBranches.sourceId, request.sourceId))
    .run();
  const removed =
    rewrite === null
      ? request.pending.map((one) => ({
          assignmentId: one.assignmentId,
          commit: one.landing.landedCommit,
        }))
      : [
          { landingId: rewrite.replaces, commit: rewrite.replacedCommit },
          ...(rewrite.takeOut?.removed ?? []),
        ].map((one) => ({
          assignmentId:
            db.select().from(landings).where(eq(landings.id, one.landingId)).all()[0]
              ?.assignmentId ?? "",
          commit: one.commit,
        }));
  return {
    status: "taken-out",
    sourceId: request.sourceId,
    branch: plan.name,
    planRevision: request.planRevision,
    from: plan.from,
    to: plan.to,
    removed,
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

/** Moves the branch for one recorded take-out intent, then records the outcome. */
async function settle(request: TakeOutCall, intent: LandingRow): Promise<Reported> {
  const plan = planOfLanding(intent);
  const subject = { assignmentId: intent.assignmentId, branch: plan.name };
  const moved = await IntegrationBranch.move({
    repoRoot: request.projectRoot,
    name: plan.name,
    from: plan.from,
    to: plan.to,
  });
  if (moved.status === "tip-moved") {
    return {
      repeated: false,
      result: {
        status: "integration-branch-moved",
        ...subject,
        recordedTip: plan.from,
        found: moved.found,
        checkedOut: moved.checkedOut,
      },
    };
  }
  if (moved.status === "checked-out") {
    return {
      repeated: false,
      result: { status: "integration-branch-checked-out", ...subject, worktrees: moved.worktrees },
    };
  }
  if (moved.status === "unread") {
    return {
      repeated: false,
      result: { status: "integration-branch-unread", ...subject, detail: moved.detail },
    };
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
        landingId: intent.id,
        plan,
        pending: pendingTakeOutsOf(db, request.sourceId),
        planRevision: rewriteOf(intent)?.takeOut?.planRevision ?? request.planRevision,
        now,
      });
    },
  );
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
    const read = readTakeOut(db, request);
    return read.status === "ready" ? { status: "take-out-intended", landingId: "" } : read;
  });
  if (probed.repeated || probed.result.status !== "take-out-intended") {
    return probed;
  }

  const read = await readState(request.projectRoot, (db) => readTakeOut(db, request));
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
  const { rewrite, row } = planned;
  // A withdrawn landing on a commit that a live result shares leaves the record only.
  if (rewrite === null) {
    return writeOnce(request, "", input, (db, now) =>
      recordedTipOf(db, request.sourceId) === row.recordedTip
        ? recordTakeOut(db, {
            sourceId: request.sourceId,
            landingId: null,
            plan: {
              status: "ready",
              name: row.name,
              from: row.recordedTip,
              to: row.recordedTip,
              landed: row.recordedTip,
              landedParent: row.recordedTip,
              kind: "take-out",
              tree: "",
              patch: "",
              rewrite: null,
            },
            pending: pendingTakeOutsOf(db, request.sourceId),
            planRevision: planned.planRevision,
            now,
          })
        : {
            status: "landing-tip-changed",
            assignmentId: planned.pending[0]?.assignmentId ?? "",
            planned: row.recordedTip,
            recordedTip: recordedTipOf(db, request.sourceId),
          },
    );
  }

  const replaced = planned.pending.find(
    (one) => one.landing.id === rewrite.landing.plan.rewrite?.replaces,
  );
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
        assignmentId: replaced?.assignmentId ?? "",
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
  const intended = await writeOnce(request, ":landing", { ...input, plan }, (db, now) => {
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
    if (recordedTip !== plan.from || replaced === undefined) {
      return {
        status: "landing-tip-changed",
        assignmentId: replaced?.assignmentId ?? "",
        planned: plan.from,
        recordedTip,
      };
    }
    insertLandingIntent(db, {
      landingId,
      sourceId: request.sourceId,
      assignmentId: replaced.assignmentId,
      submissionId: replaced.landing.submissionId,
      plan,
      now,
    });
    return { status: "take-out-intended", landingId };
  });
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
}): Promise<GateStartResult | TakeOutRefusal | PlanRefusal | StateFailure> {
  const planned = await planTakeOut({ ...request, planRevision: null });
  if (planned.status !== "planned") {
    return planned;
  }
  const { rewrite, row } = planned;
  const gated =
    rewrite === null
      ? { gate: { status: "passed" } as RangeGate }
      : await readState(request.projectRoot, (db) => ({ gate: rangeGateOf(db, rewrite) }));
  if (!("gate" in gated)) {
    return gated;
  }
  const { gate } = gated;
  if (gate.status === "passed") {
    const last = rewrite?.gated.at(-1);
    return {
      status: "gate-passed",
      key: { tree: last?.tree ?? "", declarationIdentity: row.gateIdentity },
      commit: rewrite?.landing.plan.to ?? row.recordedTip,
      runIds: [],
    };
  }
  if (gate.status === "running") {
    return {
      status: "gate-running",
      runId: gate.runIds[0] ?? "",
      detail: `Gate run ${gate.runIds.join(", ")} still runs at commit ${gate.commit} of the rebuilt range.`,
    };
  }
  return startRun({
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
  });
}
