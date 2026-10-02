import { and, eq } from "drizzle-orm";
import { IntegrationBranch } from "../integration-branch/main.ts";
import type { CrewReader, CrewWriter } from "./database.ts";
import { type GateKey, keyStatus } from "./gate-runs.ts";
import { type IntegrationBranchRow, integrationBranchOf } from "./integration.ts";
import { integrationBranches, landings } from "./schema.ts";

export type LandingRow = typeof landings.$inferSelect;

/** One planned landing as the integration branch module gives it. */
export type LandingPlan = Extract<
  Awaited<ReturnType<typeof IntegrationBranch.plan>>,
  { status: "ready" }
>;

/** The landing of one source whose move has no recorded outcome, or null. */
export function intendedLandingOf(db: CrewReader, sourceId: string): LandingRow | null {
  return (
    db
      .select()
      .from(landings)
      .where(and(eq(landings.sourceId, sourceId), eq(landings.state, "intended")))
      .all()[0] ?? null
  );
}

/** True when an earlier submission of one assignment landed, so this one is a correction. */
export function landedEarlier(
  db: CrewReader,
  request: { assignmentId: string; submissionId: string },
): boolean {
  return db
    .select()
    .from(landings)
    .where(and(eq(landings.assignmentId, request.assignmentId), eq(landings.state, "landed")))
    .all()
    .some((one) => one.submissionId !== request.submissionId);
}

/** The recorded landing of one submission, or null when it never landed. */
export function landingOfSubmission(db: CrewReader, submissionId: string): LandingRow | null {
  return (
    db
      .select()
      .from(landings)
      .where(and(eq(landings.submissionId, submissionId), eq(landings.state, "landed")))
      .all()[0] ?? null
  );
}

/**
 * The refusals of a landing, members of the durable unions of ADR 0011. Each one lands nothing
 * and records nothing. Operator never resets the branch and never adopts a tip it did not
 * record, so a person puts a moved branch back.
 */
export type LandingRefusal =
  | { status: "integration-branch-missing"; assignmentId: string; sourceId: string }
  | {
      status: "integration-branch-moved";
      assignmentId: string;
      branch: string;
      recordedTip: string;
      found: string | null;
      checkedOut: string[];
    }
  | {
      status: "integration-branch-checked-out";
      assignmentId: string;
      branch: string;
      worktrees: string[];
    }
  | { status: "integration-branch-unread"; assignmentId: string; branch: string; detail: string }
  | {
      status: "landing-conflict";
      assignmentId: string;
      branch: string;
      tip: string;
      commit: string;
      paths: string[];
    }
  | {
      status: "landing-patch-changed";
      assignmentId: string;
      branch: string;
      tip: string;
      commit: string;
    }
  | {
      status: "landing-gate-not-passed";
      assignmentId: string;
      gate: "gate_pending" | "gate_running" | "gate_failed" | "gate_flaky";
      // The planned commit is the candidate, and its key is its tree and the fixed gate.
      commit: string;
      tip: string;
      key: GateKey;
      runIds: string[];
    }
  | {
      status: "landing-pending";
      assignmentId: string;
      landingId: string;
      pendingAssignmentId: string;
    };

/** The refusals that a landing plan itself gives. */
export type PlanRefusal = Extract<
  LandingRefusal,
  {
    status:
      | "integration-branch-moved"
      | "integration-branch-checked-out"
      | "integration-branch-unread"
      | "landing-conflict"
      | "landing-patch-changed";
  }
>;

/** The landing of one reviewed commit as `crew-state` asks Git for it. */
export type PlannedLanding = { row: IntegrationBranchRow; plan: LandingPlan };

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
}): Promise<{ status: "planned"; landing: PlannedLanding } | PlanRefusal> {
  const { row } = request;
  const plan = await IntegrationBranch.plan({
    repoRoot: request.projectRoot,
    name: row.name,
    base: row.baseCommit,
    recordedTip: row.recordedTip,
    commit: request.commit,
    reviewedBase: request.reviewedBase,
  });
  const subject = { assignmentId: request.assignmentId, branch: row.name };
  switch (plan.status) {
    case "ready":
      return { status: "planned", landing: { row, plan } };
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
    case "conflict":
      return {
        status: "landing-conflict",
        ...subject,
        tip: row.recordedTip,
        commit: request.commit,
        paths: plan.paths,
      };
    case "patch-changed":
      return {
        status: "landing-patch-changed",
        ...subject,
        tip: row.recordedTip,
        commit: request.commit,
      };
    default:
      return { status: "integration-branch-unread", ...subject, detail: plan.detail };
  }
}

/** The key of a planned commit: its tree and the gate declaration fixed on its source. */
export function candidateKey(landing: PlannedLanding): GateKey {
  return { tree: landing.plan.tree, declarationIdentity: landing.row.gateIdentity };
}

/**
 * The gate of acceptance on the planned commit (ADR 0021). A landing that lands nothing gates
 * nothing, because the branch keeps a tip that already passed at its own landing.
 */
export function candidateGate(
  db: CrewReader,
  request: { assignmentId: string; landing: PlannedLanding },
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
    kind: landing.kind === "merge" || landing.kind === "held" ? landing.kind : "fast-forward",
    tree: "",
    patch: landing.patch,
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
    })
    .run();
}

/**
 * Records the outcome of one landing in the same transaction as its acceptance: the landing, the
 * new recorded tip, and the commit on the branch that carries the result. A landing that lands
 * nothing has no intent, so its record is written here at once.
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
    now: string;
  },
): void {
  if (request.intended) {
    db.update(landings)
      .set({ state: "landed", landedAt: request.now })
      .where(eq(landings.id, request.landingId))
      .run();
  } else {
    insertLandingIntent(db, request);
    db.update(landings)
      .set({ state: "landed", landedAt: request.now })
      .where(eq(landings.id, request.landingId))
      .run();
  }
  db.update(integrationBranches)
    .set({ recordedTip: request.plan.to, updatedAt: request.now })
    .where(eq(integrationBranches.sourceId, request.sourceId))
    .run();
}

/** The recorded tip of one source, read again inside the transaction that moves it. */
export function recordedTipOf(db: CrewReader, sourceId: string): string | null {
  return integrationBranchOf(db, sourceId)?.recordedTip ?? null;
}
