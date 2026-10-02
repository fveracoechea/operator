import { and, eq } from "drizzle-orm";
import { IntegrationBranch } from "../integration-branch/main.ts";
import { moveAssignment, readAssignment } from "./assignment.ts";
import type { CrewReader, CrewWriter } from "./database.ts";
import { type GateKey, keyStatus } from "./gate-runs.ts";
import type { IntegrationBranchRow } from "./integration.ts";
import {
  landedOfSource,
  type LandingRefusal,
  type LandingRow,
  type PlannedLanding,
  type PlanRefusal,
  type RewriteRecord,
} from "./landing.ts";
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
export type PlannedRewrite = { landing: PlannedLanding; gated: GatedCommit[]; correction: boolean };

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
  while (queue.length > 0) {
    const next = queue.pop() ?? "";
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

/** The crew-state side of one rebuild: the later landings, the refused trees, the published heads. */
function readRebuild(
  db: CrewReader,
  request: { row: IntegrationBranchRow; replaced: LandingRow; drop: Set<string> },
) {
  const { row, replaced } = request;
  const later = laterLandings(db, { row, replaced });
  if (later === null) {
    return null;
  }
  const owners = later.map((one) => new Set(one.rows.map((landing) => landing.assignmentId)));
  return {
    later: later.map((one, index) => {
      const needed = new Set(
        one.rows.flatMap((landing) => [...dependenciesOf(db, landing.assignmentId)]),
      );
      return {
        ...one,
        drop: request.drop.has(one.commit),
        needs: [
          // A result that depends on the replaced one needs it, which only a take-out removes.
          ...(needed.has(replaced.assignmentId) ? [replaced.landedCommit] : []),
          ...later
            .slice(0, index)
            .filter((_, earlier) => [...(owners[earlier] ?? [])].some((id) => needed.has(id)))
            .map((earlier) => earlier.commit),
        ],
      };
    }),
    refused: refusedTrees(db, row),
    // Each part people still read or that merged, lowest first. A recalled part no longer
    // guards its range, so the change runs after the recall (decision 23).
    published: guardedRangesOf(db, row.sourceId),
  };
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
  | { kind: "correction"; commit: string; reviewedBase: string }
  | {
      kind: "take-out";
      planRevision: string;
      // Every withdrawn landing that the take-out removes, the replaced one among them.
      withdrawn: LandingRow[];
    };

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
  const subject = { assignmentId: request.assignmentId, branch: row.name };
  const withdrawn = rebuild.kind === "take-out" ? rebuild.withdrawn : [];
  const withdrawnIds = new Set(withdrawn.map((one) => one.id));
  const read = await readState(request.projectRoot, (db) => {
    // A later commit leaves with the replaced one only when every result it carries is withdrawn.
    const drop = new Set(
      laterLandings(db, { row, replaced })
        ?.filter((one) => one.rows.every((landing) => withdrawnIds.has(landing.id)))
        .map((one) => one.commit) ?? [],
    );
    return readRebuild(db, { row, replaced, drop });
  });
  if (read === null) {
    return {
      status: "integration-branch-unread",
      ...subject,
      detail: `The recorded landings of ${row.name} do not lead from ${row.recordedTip} to ${replaced.landedCommit}.`,
    };
  }
  if ("status" in read) {
    return read;
  }

  const plan = await IntegrationBranch.rewrite({
    repoRoot: request.projectRoot,
    name: row.name,
    base: row.baseCommit,
    recordedTip: row.recordedTip,
    replaces: replaced.landedCommit,
    correction:
      rebuild.kind === "correction"
        ? { commit: rebuild.commit, reviewedBase: rebuild.reviewedBase }
        : null,
    later: read.later.map((one) => ({ commit: one.commit, needs: one.needs, drop: one.drop })),
    refused: read.refused,
    published: read.published,
  });
  const commit = rebuild.kind === "correction" ? rebuild.commit : replaced.landedCommit;
  switch (plan.status) {
    case "ready":
      break;
    case "tip-moved":
      return {
        status: "integration-branch-moved",
        ...subject,
        recordedTip: row.recordedTip,
        found: plan.found,
        checkedOut: plan.checkedOut,
      };
    case "checked-out":
      return { status: "integration-branch-checked-out", ...subject, worktrees: plan.worktrees };
    case "published-range":
      return {
        status: "rewrite-published-range",
        ...subject,
        commit: replaced.landedCommit,
        pullRequest: plan.pullRequest,
        url: plan.url,
      };
    // The correction lands on the parent of the commit it replaces, so that is the tip it names.
    case "conflict":
      return {
        status: "landing-conflict",
        ...subject,
        tip: replaced.landedParent,
        commit,
        paths: plan.paths,
      };
    case "patch-changed":
      return { status: "landing-patch-changed", ...subject, tip: replaced.landedParent, commit };
    default:
      return { status: "integration-branch-unread", ...subject, detail: plan.detail };
  }

  const rowsOf = new Map(read.later.map((one) => [one.commit, one.rows]));
  const live = (rows: LandingRow[] | undefined) =>
    (rows ?? []).filter((landing) => !withdrawnIds.has(landing.id));
  const rewrite: RewriteRecord = {
    replaces: replaced.id,
    replacedCommit: replaced.landedCommit,
    relanded: plan.relanded.flatMap((one) =>
      live(rowsOf.get(one.was)).map((landing) => ({
        landingId: landing.id,
        assignmentId: landing.assignmentId,
        from: one.was,
        to: one.commit,
        parent: one.parent,
      })),
    ),
    takenOut: plan.takenOut.flatMap((one) =>
      live(rowsOf.get(one.commit)).map((landing) => ({
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
    return { status: "rewrite-tracker-recorded", ...subject, steps: held };
  }

  const correction = plan.correction;
  const gated: GatedCommit[] = [
    ...(correction === null
      ? []
      : [{ commit: correction.commit, parent: correction.parent, tree: correction.tree }]),
    ...plan.relanded.map((one) => ({ commit: one.commit, parent: one.parent, tree: one.tree })),
  ];
  return {
    status: "planned",
    rewrite: {
      landing: {
        row,
        plan: {
          status: "ready",
          name: plan.name,
          from: plan.from,
          to: plan.to,
          landed: correction?.commit ?? replaced.landedCommit,
          landedParent: correction?.parent ?? plan.replaced.parent,
          kind: rebuild.kind === "correction" ? "rewrite" : "take-out",
          tree: gated.at(-1)?.tree ?? correction?.tree ?? "",
          patch: correction?.patch ?? replaced.patch,
          rewrite,
        },
      },
      // A take-out lands nothing in the place of the replaced commit, so only the later ones run.
      gated,
      correction: correction !== null,
    },
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
    rebuild: { kind: "correction", commit: request.commit, reviewedBase: request.reviewedBase },
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
 * records the correction. The replaced landing ends, each later landing that landed again names
 * its new commit, and each one taken out ends and returns its assignment to awaiting review, so
 * its acceptance is taken again as an ordinary landing on the new tip (ADR 0020).
 */
export function applyRewrite(db: CrewWriter, request: { rewrite: RewriteRecord; now: string }) {
  const { rewrite, now } = request;
  // A take-out puts nothing in the place of the withdrawn commits, so each one is taken out.
  db.update(landings)
    .set({ state: rewrite.takeOut === null ? "replaced" : "taken-out" })
    .where(eq(landings.id, rewrite.replaces))
    .run();
  for (const one of rewrite.takeOut?.removed ?? []) {
    db.update(landings).set({ state: "taken-out" }).where(eq(landings.id, one.landingId)).run();
  }
  relandAll(db, rewrite.relanded);
  takeOutAll(db, { takenOut: rewrite.takenOut, now });
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
 * Each landing that a rebuild took out ends, and its accepted assignment returns to awaiting
 * review, so its acceptance is taken again as an ordinary landing on the new tip (ADR 0020).
 */
export function takeOutAll(
  db: CrewWriter,
  request: { takenOut: RewriteRecord["takenOut"]; now: string },
): void {
  const { now } = request;
  for (const one of request.takenOut) {
    const landing = db.select().from(landings).where(eq(landings.id, one.landingId)).all()[0];
    db.update(landings).set({ state: "taken-out" }).where(eq(landings.id, one.landingId)).run();
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
