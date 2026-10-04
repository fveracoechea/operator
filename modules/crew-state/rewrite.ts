import { and, eq } from "drizzle-orm";
import { IntegrationBranch } from "../integration-branch/main.ts";
import { moveAssignment, readAssignment } from "./assignment.ts";
import type { CrewReader, CrewWriter } from "./database.ts";
import { type GateKey, keyStatus } from "./gate-runs.ts";
import type { IntegrationBranchRow } from "./integration.ts";
import { branchRefusalOf, type LandingRefusal, type PlanRefusal } from "./branch-move.ts";
import type { PlannedMove } from "./landing.ts";
import { landedOfSource, type LandingRow, type RewriteRecord } from "./landing-record.ts";
import { readState, type StateFailure } from "./operations.ts";
import { guardedRangesOf } from "./stack-parts.ts";
import { assignmentDependencies, attempts, gateRuns, landings, submissions } from "./schema.ts";
import { trackerOperationsOf } from "./tracker.ts";

/** One commit of a rebuilt range, in branch order, with the commit it lands on. */
export type GatedCommit = { commit: string; parent: string; tree: string };

/**
 * A planned rewrite and the rebuilt range that the project gate runs on, in order. The first
 * commit of the range is the correction itself, unless the rewrite is a take-out.
 */
export type PlannedRewrite = { landing: PlannedMove; gated: GatedCommit[]; correction: boolean };

export type LaterLanding = { commit: string; parent: string; rows: LandingRow[] };

/**
 * The landings above the replaced one, oldest first, read from the record alone: each recorded
 * landing names its commit and the parent it landed on, from the recorded tip down. A record that
 * does not reach the replaced commit gives null, and the rewrite then refuses.
 */
export function laterLandings(
  db: CrewReader,
  request: { row: IntegrationBranchRow; replaced: Pick<LandingRow, "landedCommit"> },
): LaterLanding[] | null {
  const byCommit = new Map<string, LandingRow[]>();
  for (const one of landedOfSource(db, request.row.sourceId)) {
    byCommit.set(one.landedCommit, [...(byCommit.get(one.landedCommit) ?? []), one]);
  }
  const later: LaterLanding[] = [];
  let commit = request.row.recordedTip;
  while (commit !== request.replaced.landedCommit) {
    const rows = byCommit.get(commit) ?? [];
    const [first] = rows;
    if (first === undefined || commit === request.row.baseCommit) {
      return null;
    }
    later.push({ commit, parent: first.landedParent, rows });
    commit = first.landedParent;
  }
  return later.toReversed();
}

/** Every assignment that one assignment depends on, directly or through another one. */
function dependenciesOf(db: CrewReader, assignmentId: string): Set<string> {
  const found = new Set<string>();
  const queue = [assignmentId];
  for (let next = queue.pop(); next !== undefined; next = queue.pop()) {
    for (const edge of db
      .select()
      .from(assignmentDependencies)
      .where(eq(assignmentDependencies.assignmentId, next))
      .all()) {
      if (!found.has(edge.dependsOnId)) {
        found.add(edge.dependsOnId);
        queue.push(edge.dependsOnId);
      }
    }
  }
  return found;
}

/**
 * The trees of one source whose key failed or is flaky under the gate fixed on it. A later
 * commit that lands again at one of them fails the third test of a rewrite (ADR 0021).
 */
export function refusedTrees(db: CrewReader, row: IntegrationBranchRow): string[] {
  const trees = new Set(
    db
      .select()
      .from(gateRuns)
      .where(
        and(
          eq(gateRuns.sourceId, row.sourceId),
          eq(gateRuns.declarationIdentity, row.gateIdentity),
          eq(gateRuns.state, "failed"),
        ),
      )
      .all()
      .map((one) => one.tree),
  );
  return [...trees].filter((tree) => {
    const verdict = keyStatus(db, { tree, declarationIdentity: row.gateIdentity });
    return verdict.status === "failed" || verdict.status === "flaky";
  });
}

/**
 * Each landing with the commits below it, in the same list, that hold a result it needs. A rebase
 * reads the whole branch this way, from its base.
 */
export function withNeeds(
  db: CrewReader,
  later: LaterLanding[],
): Array<LaterLanding & { needs: string[] }> {
  const owners = later.map((one) => new Set(one.rows.map((landing) => landing.assignmentId)));
  return later.map((one, index) => {
    const needed = new Set(
      one.rows.flatMap((landing) => [...dependenciesOf(db, landing.assignmentId)]),
    );
    return {
      ...one,
      needs: later
        .slice(0, index)
        .filter((_, earlier) => [...(owners[earlier] ?? [])].some((id) => needed.has(id)))
        .map((earlier) => earlier.commit),
    };
  });
}

/**
 * Each tracker step that is recorded for a result that a rebuild moves back to awaiting review.
 * Such a step ran when an earlier release completed a code result at its acceptance, so its
 * ticket says the work is done while its commit leaves the branch. The rebuild holds, and a
 * person decides, because Operator writes no tracker step to undo another one (#114).
 */
export function trackerHold(
  db: CrewReader,
  assignmentIds: string[],
): Array<{ assignmentId: string; step: string; state: string }> {
  return [...new Set(assignmentIds)].flatMap((assignmentId) => {
    const row = readAssignment(db, assignmentId);
    return row === null || row.state !== "accepted"
      ? []
      : trackerOperationsOf(db, assignmentId).map((one) => ({
          assignmentId,
          step: one.step,
          state: one.state,
        }));
  });
}

/** What one rebuild puts in the place of its replaced commit, and what it removes with it. */
type Rebuild =
  | { kind: "rewrite"; commit: string; reviewedBase: string }
  | {
      kind: "take-out";
      planRevision: string;
      // Every withdrawn landing that the take-out removes, the replaced one among them.
      withdrawn: LandingRow[];
    };

/**
 * The crew-state side of one rebuild: the later landings with the commits each one needs, the
 * refused trees, and the published heads. A record that does not reach the replaced commit gives
 * null.
 */
function readRebuild(
  db: CrewReader,
  request: { row: IntegrationBranchRow; replaced: LandingRow; withdrawn: Set<string> },
) {
  const { row, replaced } = request;
  const later = laterLandings(db, { row, replaced });
  if (later === null) {
    return null;
  }
  return {
    later: withNeeds(db, later).map((one) => ({
      ...one,
      // A later commit leaves with the replaced one only when every result it carries is withdrawn.
      drop: one.rows.every((landing) => request.withdrawn.has(landing.id)),
      needs: [
        // A result that depends on the replaced one needs it, which only a take-out removes.
        ...(one.rows.some((landing) =>
          dependenciesOf(db, landing.assignmentId).has(replaced.assignmentId),
        )
          ? [replaced.landedCommit]
          : []),
        ...one.needs,
      ],
    })),
    refused: refusedTrees(db, row),
    // Each part people still read or that merged, lowest first. A recalled part no longer
    // guards its range, so the change runs after the recall (decision 23).
    published: guardedRangesOf(db, row.sourceId),
  };
}

type RewriteOutcome = Awaited<ReturnType<typeof IntegrationBranch.rewrite>>;
type ReadyRewrite = Extract<RewriteOutcome, { status: "ready" }>;

/**
 * The refusal of one refused rewrite plan. A correction lands on the parent of the commit it
 * replaces, so that is the tip a conflict names.
 */
function rewriteRefusalOf(
  plan: Exclude<RewriteOutcome, ReadyRewrite>,
  request: {
    assignmentId: string;
    row: IntegrationBranchRow;
    replaced: LandingRow;
    commit: string;
  },
): PlanRefusal {
  const { row, replaced } = request;
  if (plan.status === "published-range") {
    return {
      status: "rewrite-published-range",
      assignmentId: request.assignmentId,
      branch: row.name,
      commit: replaced.landedCommit,
      pullRequest: plan.pullRequest,
      url: plan.url,
    };
  }
  return branchRefusalOf(plan, {
    assignmentId: request.assignmentId,
    branch: row.name,
    recordedTip: row.recordedTip,
    tip: replaced.landedParent,
    commit: request.commit,
  });
}

/**
 * The record of one planned rebuild: each later landing that lands again or is taken out, read
 * from the rows of its commit, and the withdrawn landings that a take-out removes. A withdrawn
 * landing is never relanded or taken out on its own, because it leaves with the take-out.
 */
function rewriteRecordOf(request: {
  plan: ReadyRewrite;
  later: LaterLanding[];
  replaced: LandingRow;
  rebuild: Rebuild;
}): RewriteRecord {
  const { plan, replaced, rebuild } = request;
  const withdrawn = rebuild.kind === "take-out" ? rebuild.withdrawn : [];
  const rowsOf = new Map(request.later.map((one) => [one.commit, one.rows]));
  const live = (commit: string) =>
    (rowsOf.get(commit) ?? []).filter((landing) => !withdrawn.some((one) => one.id === landing.id));
  return {
    replaces: replaced.id,
    replacedCommit: replaced.landedCommit,
    relanded: plan.relanded.flatMap((one) =>
      live(one.was).map((landing) => ({
        landingId: landing.id,
        assignmentId: landing.assignmentId,
        from: one.was,
        to: one.commit,
        parent: one.parent,
      })),
    ),
    takenOut: plan.takenOut.flatMap((one) =>
      live(one.commit).map((landing) => ({
        landingId: landing.id,
        assignmentId: landing.assignmentId,
        commit: one.commit,
        cause: one.cause,
      })),
    ),
    takeOut:
      rebuild.kind === "take-out"
        ? {
            planRevision: rebuild.planRevision,
            removed: withdrawn
              .filter((one) => one.id !== replaced.id)
              .map((one) => ({
                landingId: one.id,
                assignmentId: one.assignmentId,
                commit: one.landedCommit,
              })),
          }
        : null,
  };
}

/**
 * The planned move of one rebuild and the range the project gate runs on, in order. A take-out
 * lands nothing in the place of the replaced commit, so only the later commits run.
 */
function plannedRewriteOf(request: {
  row: IntegrationBranchRow;
  plan: ReadyRewrite;
  replaced: LandingRow;
  kind: Rebuild["kind"];
  rewrite: RewriteRecord;
}): PlannedRewrite {
  const { plan, replaced } = request;
  const { correction } = plan;
  const gated = [
    ...(correction === null
      ? []
      : [{ commit: correction.commit, parent: correction.parent, tree: correction.tree }]),
    ...plan.relanded.map((one) => ({ commit: one.commit, parent: one.parent, tree: one.tree })),
  ];
  return {
    landing: {
      row: request.row,
      tree: gated.at(-1)?.tree ?? "",
      plan: {
        status: "ready",
        name: plan.name,
        from: plan.from,
        to: plan.to,
        landed: correction?.commit ?? replaced.landedCommit,
        landedParent: correction?.parent ?? plan.replaced.parent,
        kind: request.kind,
        patch: correction?.patch ?? replaced.patch,
        rewrite: request.rewrite,
      },
    },
    gated,
    correction: correction !== null,
  };
}

/**
 * Plans one rebuild of the integration branch in the same order (ADR 0020). A correction takes
 * the place of its landed commit, and a take-out removes every withdrawn commit with nothing in
 * its place. The later landings, the commits each one needs, and the trees the gate refused are
 * read from the crew state, and Git builds the rebuilt range. A refusal moves nothing and
 * records nothing.
 */
async function planRebuild(request: {
  projectRoot: string;
  assignmentId: string;
  row: IntegrationBranchRow;
  replaced: LandingRow;
  rebuild: Rebuild;
}): Promise<{ status: "planned"; rewrite: PlannedRewrite } | PlanRefusal | StateFailure> {
  const { row, replaced, rebuild } = request;
  const withdrawn = new Set(
    (rebuild.kind === "take-out" ? rebuild.withdrawn : []).map((one) => one.id),
  );
  const read = await readState(request.projectRoot, (db) =>
    readRebuild(db, { row, replaced, withdrawn }),
  );
  if (read === null) {
    return {
      status: "integration-branch-unread",
      assignmentId: request.assignmentId,
      branch: row.name,
      detail: `The recorded landings of ${row.name} do not lead from ${row.recordedTip} to ${replaced.landedCommit}.`,
    };
  }
  if ("status" in read) {
    return read;
  }

  const correction =
    rebuild.kind === "rewrite"
      ? { commit: rebuild.commit, reviewedBase: rebuild.reviewedBase }
      : null;
  const plan = await IntegrationBranch.rewrite({
    repoRoot: request.projectRoot,
    name: row.name,
    base: row.baseCommit,
    recordedTip: row.recordedTip,
    replaces: replaced.landedCommit,
    correction,
    later: read.later.map((one) => ({ commit: one.commit, needs: one.needs, drop: one.drop })),
    refused: read.refused,
    published: read.published,
  });
  if (plan.status !== "ready") {
    return rewriteRefusalOf(plan, {
      assignmentId: request.assignmentId,
      row,
      replaced,
      commit: correction?.commit ?? replaced.landedCommit,
    });
  }

  const rewrite = rewriteRecordOf({ plan, later: read.later, replaced, rebuild });
  const held = await readState(request.projectRoot, (db) =>
    trackerHold(
      db,
      rewrite.takenOut.map((one) => one.assignmentId),
    ),
  );
  if (!Array.isArray(held)) {
    return held;
  }
  if (held.length > 0) {
    return {
      status: "rewrite-tracker-recorded",
      assignmentId: request.assignmentId,
      branch: row.name,
      steps: held,
    };
  }
  return {
    status: "planned",
    rewrite: plannedRewriteOf({ row, plan, replaced, kind: rebuild.kind, rewrite }),
  };
}

/**
 * Plans the rewrite that puts one corrected result in the place of its landed commit (ADR 0020).
 * A refusal moves nothing and records nothing.
 */
export function planRewrite(request: {
  projectRoot: string;
  assignmentId: string;
  row: IntegrationBranchRow;
  replaced: LandingRow;
  commit: string;
  reviewedBase: string;
}): Promise<{ status: "planned"; rewrite: PlannedRewrite } | PlanRefusal | StateFailure> {
  return planRebuild({
    ...request,
    rebuild: { kind: "rewrite", commit: request.commit, reviewedBase: request.reviewedBase },
  });
}

/**
 * Plans the take-out of every withdrawn commit of one source that the branch still holds: the
 * rewrite of ADR 0020 with no replacement. The lowest withdrawn commit is the replaced one, and
 * each other withdrawn commit leaves with it. A refusal moves nothing and records nothing.
 */
export function planTakeOutRebuild(request: {
  projectRoot: string;
  row: IntegrationBranchRow;
  replaced: LandingRow;
  withdrawn: LandingRow[];
  planRevision: string;
}): Promise<{ status: "planned"; rewrite: PlannedRewrite } | PlanRefusal | StateFailure> {
  return planRebuild({
    projectRoot: request.projectRoot,
    assignmentId: request.replaced.assignmentId,
    row: request.row,
    replaced: request.replaced,
    rebuild: {
      kind: "take-out",
      planRevision: request.planRevision,
      withdrawn: request.withdrawn,
    },
  });
}

/** Where the project gate stands on a rebuilt range: the first commit that has not passed. */
export type RangeGate =
  | { status: "passed" }
  | {
      status: "pending" | "running" | "failed" | "flaky";
      commit: string;
      parent: string;
      key: GateKey;
      runIds: string[];
      // True when it is the correction itself, which an integration cycle then answers.
      correction: boolean;
    };

/**
 * Gates a rebuilt range in order and stops at the first commit whose key has not passed (ADR
 * 0021). A later commit whose key failed was taken out by the plan already, so only the
 * correction itself can be failed or flaky here.
 */
export function rangeGateOf(db: CrewReader, rewrite: PlannedRewrite): RangeGate {
  const declarationIdentity = rewrite.landing.row.gateIdentity;
  for (const [index, one] of rewrite.gated.entries()) {
    const key = { tree: one.tree, declarationIdentity };
    const verdict = keyStatus(db, key);
    if (verdict.status === "passed") {
      continue;
    }
    const place = {
      commit: one.commit,
      parent: one.parent,
      key,
      correction: rewrite.correction && index === 0,
    };
    switch (verdict.status) {
      case "pending":
        return { status: "pending", ...place, runIds: [] };
      case "running":
        return { status: "running", ...place, runIds: [verdict.run.id] };
      default:
        return { status: verdict.status, ...place, runIds: verdict.failed.map((run) => run.id) };
    }
  }
  return { status: "passed" };
}

/** The gate of acceptance on a rebuilt range, as the refusal that `work accept` reports. */
export function rewriteGate(
  db: CrewReader,
  request: { assignmentId: string; rewrite: PlannedRewrite },
): LandingRefusal | null {
  const gate = rangeGateOf(db, request.rewrite);
  if (gate.status === "passed") {
    return null;
  }
  return {
    status: "landing-gate-not-passed",
    assignmentId: request.assignmentId,
    gate: `gate_${gate.status}`,
    commit: gate.commit,
    tip: gate.parent,
    key: gate.key,
    runIds: gate.runIds,
  };
}

/**
 * Records what a rewrite did to the other landings of its source, in the transaction that
 * records the correction, after the branch move wrote the next state of each landing it ended.
 * Each later landing that landed again names its new commit, and each one taken out returns its
 * assignment to awaiting review, so its acceptance is taken again as an ordinary landing on the
 * new tip (ADR 0020).
 */
export function applyRewrite(db: CrewWriter, request: { rewrite: RewriteRecord; now: string }) {
  relandAll(db, request.rewrite.relanded);
  returnTakenOut(db, { takenOut: request.rewrite.takenOut, now: request.now });
}

/** Each landing that a rebuild landed again names its new commit and parent. */
export function relandAll(db: CrewWriter, relanded: RewriteRecord["relanded"]): void {
  for (const one of relanded) {
    db.update(landings)
      .set({ landedCommit: one.to, landedParent: one.parent })
      .where(eq(landings.id, one.landingId))
      .run();
  }
}

/**
 * The accepted assignment of each landing that a rebuild took out returns to awaiting review, so
 * its acceptance is taken again as an ordinary landing on the new tip (ADR 0020). The branch move
 * already ended each such landing.
 */
export function returnTakenOut(
  db: CrewWriter,
  request: { takenOut: RewriteRecord["takenOut"]; now: string },
): void {
  const { now } = request;
  for (const one of request.takenOut) {
    const landing = db.select().from(landings).where(eq(landings.id, one.landingId)).all()[0];
    const row = readAssignment(db, one.assignmentId);
    if (landing === undefined || row === null || row.state !== "accepted") {
      continue;
    }
    moveAssignment(db, { row, state: "awaiting-review", now });
    const submission = db
      .select()
      .from(submissions)
      .where(eq(submissions.id, landing.submissionId))
      .all()[0];
    if (submission === undefined) {
      continue;
    }
    db.update(submissions)
      .set({ state: "submitted", revision: submission.revision + 1, updatedAt: now })
      .where(eq(submissions.id, submission.id))
      .run();
    db.update(attempts)
      .set({ state: "submitted" })
      .where(and(eq(attempts.id, submission.attemptId), eq(attempts.state, "accepted")))
      .run();
  }
}
