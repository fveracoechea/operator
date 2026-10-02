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
import { publicationsOf, pullRequestsOf } from "./publish.ts";
import { assignmentDependencies, attempts, gateRuns, landings, submissions } from "./schema.ts";

/** One commit of a rebuilt range, in branch order, with the commit it lands on. */
export type GatedCommit = { commit: string; parent: string; tree: string };

/** A planned rewrite and the rebuilt range that the project gate runs on, in order. */
export type PlannedRewrite = { landing: PlannedLanding; gated: GatedCommit[] };

type LaterLanding = { commit: string; parent: string; rows: LandingRow[] };

/**
 * The landings above the replaced one, oldest first, read from the record alone: each recorded
 * landing names its commit and the parent it landed on, from the recorded tip down. A record that
 * does not reach the replaced commit gives null, and the rewrite then refuses.
 */
function laterLandings(
  db: CrewReader,
  request: { row: IntegrationBranchRow; replaced: LandingRow },
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
function refusedTrees(db: CrewReader, row: IntegrationBranchRow): string[] {
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
 * Plans the rewrite that puts one corrected result in the place of its landed commit (ADR 0020).
 * The later landings, the commits each one needs, and the trees the gate refused are read from the
 * crew state, and Git builds the rebuilt range. A refusal moves nothing and records nothing.
 */
export async function planRewrite(request: {
  projectRoot: string;
  assignmentId: string;
  row: IntegrationBranchRow;
  replaced: LandingRow;
  commit: string;
  reviewedBase: string;
}): Promise<{ status: "planned"; rewrite: PlannedRewrite } | PlanRefusal | StateFailure> {
  const { row, replaced } = request;
  const subject = { assignmentId: request.assignmentId, branch: row.name };
  const read = await readState(request.projectRoot, (db) => {
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
          needs: later
            .slice(0, index)
            .filter((_, earlier) => [...(owners[earlier] ?? [])].some((id) => needed.has(id)))
            .map((earlier) => earlier.commit),
        };
      }),
      refused: refusedTrees(db, row),
      published: publicationsOf(db, row.sourceId).map((publication) => {
        const [first] = pullRequestsOf(db, publication.id);
        return {
          head: publication.headCommit,
          pullRequest: first?.number ?? null,
          url: first?.url ?? null,
        };
      }),
    };
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
    correction: { commit: request.commit, reviewedBase: request.reviewedBase },
    later: read.later.map((one) => ({ commit: one.commit, needs: one.needs })),
    refused: read.refused,
    published: read.published,
  });
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
        commit: request.commit,
        paths: plan.paths,
      };
    case "patch-changed":
      return {
        status: "landing-patch-changed",
        ...subject,
        tip: replaced.landedParent,
        commit: request.commit,
      };
    default:
      return { status: "integration-branch-unread", ...subject, detail: plan.detail };
  }

  const rowsOf = new Map(read.later.map((one) => [one.commit, one.rows]));
  const rewrite: RewriteRecord = {
    replaces: replaced.id,
    replacedCommit: replaced.landedCommit,
    relanded: plan.relanded.flatMap((one) =>
      (rowsOf.get(one.was) ?? []).map((landing) => ({
        landingId: landing.id,
        assignmentId: landing.assignmentId,
        from: one.was,
        to: one.commit,
        parent: one.parent,
      })),
    ),
    takenOut: plan.takenOut.flatMap((one) =>
      (rowsOf.get(one.commit) ?? []).map((landing) => ({
        landingId: landing.id,
        assignmentId: landing.assignmentId,
        commit: one.commit,
        cause: one.cause,
      })),
    ),
  };
  const gated: GatedCommit[] = [
    { commit: plan.correction.commit, parent: plan.correction.parent, tree: plan.correction.tree },
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
          landed: plan.correction.commit,
          landedParent: plan.correction.parent,
          kind: "rewrite",
          tree: gated.at(-1)?.tree ?? plan.correction.tree,
          patch: plan.correction.patch,
          rewrite,
        },
      },
      gated,
    },
  };
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
    const place = { commit: one.commit, parent: one.parent, key, correction: index === 0 };
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
  db.update(landings).set({ state: "replaced" }).where(eq(landings.id, rewrite.replaces)).run();
  for (const one of rewrite.relanded) {
    db.update(landings)
      .set({ landedCommit: one.to, landedParent: one.parent })
      .where(eq(landings.id, one.landingId))
      .run();
  }
  for (const one of rewrite.takenOut) {
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
