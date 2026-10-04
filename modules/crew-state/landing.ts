import { eq } from "drizzle-orm";
import { IntegrationBranch } from "../integration-branch/main.ts";
import type { CrewReader, CrewWriter } from "./database.ts";
import {
  branchRefusalOf,
  type LandingKind,
  landingKindOf,
  type LandingRefusal,
  type LandingWrite,
  type MoveNext,
  type PlanRefusal,
} from "./branch-move.ts";
import { type GateKey, keyStatus } from "./gate-runs.ts";
import { type IntegrationBranchRow, integrationBranchOf } from "./integration.ts";
import { type LandingRow, rewriteOf, type RewriteRecord } from "./landing-record.ts";
import { integrationBranches, landings } from "./schema.ts";

/**
 * One planned landing or rewrite, as its intent records it. A plain landing carries no rewrite
 * record. The tree of the planned tip is no part of it: only the candidate gate of a plain
 * landing reads it.
 */
export type LandingPlan = Omit<
  Extract<Awaited<ReturnType<typeof IntegrationBranch.plan>>, { status: "ready" }>,
  "kind" | "tree"
> & {
  kind: LandingKind;
  rewrite: RewriteRecord | null;
};

/**
 * One planned move of the branch of one source, with the tree of its last gated commit. The tree
 * keys the candidate gate of a plain landing (ADR 0021). A move that gates nothing, a take-out
 * with no later commit, has an empty tree.
 */
export type PlannedMove = { row: IntegrationBranchRow; plan: LandingPlan; tree: string };

/**
 * The plan that the request input of the intent of one move hashes. Earlier releases hashed the
 * plan with the tree of the move in it, so the identity of a recorded intent request stays the
 * same and a repeat still finds it.
 */
export function intentPlanOf(landing: PlannedMove): LandingPlan & { tree: string } {
  return { ...landing.plan, tree: landing.tree };
}

/** The request input of the intent of one landing that `work accept` records. */
export function landingIntentInput(request: {
  assignmentId: string;
  submissionId: string | null;
  landing: PlannedMove;
}) {
  return {
    assignmentId: request.assignmentId,
    submissionId: request.submissionId,
    plan: intentPlanOf(request.landing),
  };
}

/**
 * Plans the landing of one reviewed commit on the recorded tip of its source (ADR 0020). It
 * writes only Git objects, so a refusal lands nothing and records nothing.
 */
export async function planLanding(request: {
  projectRoot: string;
  assignmentId: string;
  row: IntegrationBranchRow;
  commit: string;
  reviewedBase: string;
}): Promise<{ status: "planned"; landing: PlannedMove } | PlanRefusal> {
  const { row } = request;
  const plan = await IntegrationBranch.plan({
    repoRoot: request.projectRoot,
    name: row.name,
    base: row.baseCommit,
    recordedTip: row.recordedTip,
    commit: request.commit,
    reviewedBase: request.reviewedBase,
  });
  if (plan.status !== "ready") {
    return branchRefusalOf(plan, {
      assignmentId: request.assignmentId,
      branch: row.name,
      recordedTip: row.recordedTip,
      tip: row.recordedTip,
      commit: request.commit,
    });
  }
  const { tree, ...planned } = plan;
  return { status: "planned", landing: { row, plan: { ...planned, rewrite: null }, tree } };
}

/** The key of a planned commit: its tree and the gate declaration fixed on its source. */
export function candidateKey(landing: PlannedMove): GateKey {
  return { tree: landing.tree, declarationIdentity: landing.row.gateIdentity };
}

/**
 * The gate of acceptance on the planned commit (ADR 0021). A landing that lands nothing gates
 * nothing, because the branch keeps a tip that already passed at its own landing.
 */
export function candidateGate(
  db: CrewReader,
  request: { assignmentId: string; landing: PlannedMove },
): LandingRefusal | null {
  const { plan } = request.landing;
  if (plan.from === plan.to) {
    return null;
  }
  const key = candidateKey(request.landing);
  const verdict = keyStatus(db, key);
  const refusal = (
    gate: Extract<LandingRefusal, { status: "landing-gate-not-passed" }>["gate"],
    runIds: string[],
  ) => ({
    status: "landing-gate-not-passed" as const,
    assignmentId: request.assignmentId,
    gate,
    commit: plan.to,
    tip: plan.from,
    key,
    runIds,
  });
  switch (verdict.status) {
    case "passed":
      return null;
    case "pending":
      return refusal("gate_pending", []);
    case "running":
      return refusal("gate_running", [verdict.run.id]);
    case "failed":
      return refusal(
        "gate_failed",
        verdict.failed.map((one) => one.id),
      );
    default:
      return refusal(
        "gate_flaky",
        verdict.failed.map((one) => one.id),
      );
  }
}

/** A plan as the intent of a landing records it, so recovery reads the same move again. */
export function planOfLanding(landing: LandingRow): LandingPlan {
  return {
    status: "ready",
    name: landing.branch,
    from: landing.fromCommit,
    to: landing.toCommit,
    landed: landing.landedCommit,
    landedParent: landing.landedParent,
    kind: landingKindOf(landing.kind),
    patch: landing.patch,
    rewrite: rewriteOf(landing),
  };
}

/**
 * Records the intent of one move before the branch moves (ADR 0005). The intent names the tip
 * the branch moves from and the commit it moves to, so recovery reads the branch once.
 */
export function insertLandingIntent(
  db: CrewWriter,
  request: {
    landingId: string;
    sourceId: string;
    assignmentId: string;
    submissionId: string;
    plan: LandingPlan;
    now: string;
  },
): void {
  db.insert(landings)
    .values({
      id: request.landingId,
      sourceId: request.sourceId,
      assignmentId: request.assignmentId,
      submissionId: request.submissionId,
      branch: request.plan.name,
      kind: request.plan.kind,
      fromCommit: request.plan.from,
      toCommit: request.plan.to,
      landedCommit: request.plan.landed,
      landedParent: request.plan.landedParent,
      patch: request.plan.patch,
      state: "intended",
      createdAt: request.now,
      landedAt: null,
      rewrite: request.plan.rewrite === null ? null : JSON.stringify(request.plan.rewrite),
    })
    .run();
}

/**
 * Records the outcome of one landing in the same transaction as its acceptance: the next state of
 * each landing that the move ends, the new recorded tip, and the commit on the branch that carries
 * the result. A landing that lands nothing has no intent, so its record is written here at once.
 */
export function recordLanding(
  db: CrewWriter,
  request: {
    landingId: string;
    intended: boolean;
    sourceId: string;
    assignmentId: string;
    submissionId: string;
    plan: LandingPlan;
    next: MoveNext;
    now: string;
  },
): void {
  if (!request.intended) {
    insertLandingIntent(db, request);
  }
  writeLandingStates(db, { landings: request.next.landings, now: request.now });
  db.update(integrationBranches)
    .set({ recordedTip: request.plan.to, updatedAt: request.now })
    .where(eq(integrationBranches.sourceId, request.sourceId))
    .run();
}

/**
 * Writes the next state of each landing that one move ends, in the transaction that records the
 * outcome of the move. A stamped landing records the move time as its landing time.
 */
export function writeLandingStates(
  db: CrewWriter,
  request: { landings: LandingWrite[]; now: string },
): void {
  for (const one of request.landings) {
    db.update(landings)
      .set(one.stamped ? { state: one.state, landedAt: request.now } : { state: one.state })
      .where(eq(landings.id, one.landingId))
      .run();
  }
}

/** The recorded tip of one source, read again inside the transaction that moves it. */
export function recordedTipOf(db: CrewReader, sourceId: string): string | null {
  return integrationBranchOf(db, sourceId)?.recordedTip ?? null;
}
