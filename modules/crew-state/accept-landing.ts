import { eq } from "drizzle-orm";
import { IntegrationBranch } from "../integration-branch/main.ts";
import { type AcceptResult, acceptAssignment, type LandingStep } from "./acceptance.ts";
import { integrationBranchOf } from "./integration.ts";
import {
  candidateGate,
  intendedLandingOf,
  type LandingPlan,
  type LandingRefusal,
  type LandingRow,
  planLanding,
  planOfLanding,
} from "./landing.ts";
import { mutate, readState, type RequestFailure, type StateFailure } from "./operations.ts";
import type { PreparedRecord } from "./planning-record.ts";
import { planRewrite, rewriteGate } from "./rewrite.ts";
import { landings } from "./schema.ts";

type AcceptCall = {
  projectRoot: string;
  requestId: string;
  ownerToken: string;
  assignmentId: string;
  attemptId: string | null;
  revision: number;
  submissionId: string | null;
  planningRecord: unknown;
  record: PreparedRecord | null;
};

type Reported = {
  repeated: boolean;
  result: AcceptResult | StateFailure | RequestFailure;
};

/** One run of every gate of acceptance, under the request identity of the acceptance itself. */
function acceptOnce(request: AcceptCall, step: LandingStep): Promise<Reported> {
  return mutate(
    {
      projectRoot: request.projectRoot,
      requestId: request.requestId,
      ownerToken: request.ownerToken,
      now: new Date().toISOString(),
      operation: "work_accept",
      input: {
        assignmentId: request.assignmentId,
        attemptId: request.attemptId,
        revision: request.revision,
        submissionId: request.submissionId,
        planningRecord: request.planningRecord,
      },
    },
    ({ tx, now }) => {
      const outcome = acceptAssignment(tx, {
        assignmentId: request.assignmentId,
        attemptId: request.attemptId,
        revision: request.revision,
        submissionId: request.submissionId,
        landing: step,
        record: request.record,
        now,
      });
      return { commit: outcome.status === "accepted", outcome };
    },
  );
}

/**
 * Records the intent of one move, after every gate of acceptance passed again in its own
 * transaction. Its request identity is derived from the acceptance, so a repeat finds it.
 */
function intendOnce(request: AcceptCall, landingId: string, plan: LandingPlan): Promise<Reported> {
  return mutate(
    {
      projectRoot: request.projectRoot,
      requestId: `${request.requestId}:landing`,
      ownerToken: request.ownerToken,
      now: new Date().toISOString(),
      operation: "work_accept_landing",
      input: { assignmentId: request.assignmentId, submissionId: request.submissionId, plan },
    },
    ({ tx, now }) => {
      const outcome = acceptAssignment(tx, {
        assignmentId: request.assignmentId,
        attemptId: request.attemptId,
        revision: request.revision,
        submissionId: request.submissionId,
        landing: { kind: "intend", landingId, plan },
        record: null,
        now,
      });
      return { commit: outcome.status === "landing-intended", outcome };
    },
  );
}

/**
 * Moves the branch for one recorded intent, then records the outcome with the acceptance.
 * Recovery reads the ref once: the old tip lands again, the planned commit records the outcome,
 * and anything else is a moved branch, which stops the landing and keeps the intent open.
 */
async function settle(
  request: AcceptCall,
  landing: { id: string; plan: LandingPlan },
): Promise<Reported> {
  const moved = await IntegrationBranch.move({
    repoRoot: request.projectRoot,
    name: landing.plan.name,
    from: landing.plan.from,
    to: landing.plan.to,
  });
  const subject = { assignmentId: request.assignmentId, branch: landing.plan.name };
  let refusal: LandingRefusal | null = null;
  if (moved.status === "tip-moved") {
    refusal = {
      status: "integration-branch-moved",
      ...subject,
      recordedTip: landing.plan.from,
      found: moved.found,
      checkedOut: moved.checkedOut,
    };
  } else if (moved.status === "checked-out") {
    refusal = { status: "integration-branch-checked-out", ...subject, worktrees: moved.worktrees };
  } else if (moved.status === "unread") {
    refusal = { status: "integration-branch-unread", ...subject, detail: moved.detail };
  }
  if (refusal !== null) {
    return { repeated: false, result: refusal };
  }
  return acceptOnce(request, {
    kind: "record",
    landingId: landing.id,
    intended: true,
    plan: landing.plan,
  });
}

/**
 * Accepts one assignment. A code result lands on the integration branch of its source as the
 * last step (ADR 0020): every other gate of acceptance, then the gate run at the planned commit,
 * then the branch move, then the record of acceptance. A refusal before the move lands nothing
 * and records nothing. An intent whose move has no recorded outcome is settled by a repeat.
 */
export async function acceptWithLanding(request: AcceptCall): Promise<Reported> {
  const probed = await acceptOnce(request, { kind: "probe" });
  if (probed.repeated || probed.result.status !== "landing-required") {
    return probed;
  }
  const required = probed.result;

  const read = await readState(request.projectRoot, (db) => ({
    row: integrationBranchOf(db, required.sourceId),
    intended: intendedLandingOf(db, required.sourceId),
    replaced:
      required.replaces === null
        ? null
        : (db.select().from(landings).where(eq(landings.id, required.replaces)).all()[0] ?? null),
  }));
  if ("status" in read) {
    return { repeated: false, result: read };
  }
  if (read.row === null) {
    return {
      repeated: false,
      result: {
        status: "integration-branch-missing",
        assignmentId: required.assignmentId,
        sourceId: required.sourceId,
      },
    };
  }
  const intended: LandingRow | null = read.intended;
  if (intended !== null) {
    if (intended.submissionId !== required.submissionId) {
      return {
        repeated: false,
        result: {
          status: "landing-pending",
          assignmentId: required.assignmentId,
          landingId: intended.id,
          pendingAssignmentId: intended.assignmentId,
        },
      };
    }
    return settle(request, { id: intended.id, plan: planOfLanding(intended) });
  }

  // A correction of a landed commit rebuilds the branch in the same order, and the project gate
  // runs on each commit of the rebuilt range in order before the branch moves once (ADR 0021).
  if (read.replaced !== null) {
    const rewritten = await planRewrite({
      projectRoot: request.projectRoot,
      assignmentId: required.assignmentId,
      row: read.row,
      replaced: read.replaced,
      commit: required.commit,
      reviewedBase: required.reviewedBase,
    });
    if (rewritten.status !== "planned") {
      return { repeated: false, result: rewritten };
    }
    const gated = await readState(request.projectRoot, (db) =>
      rewriteGate(db, { assignmentId: required.assignmentId, rewrite: rewritten.rewrite }),
    );
    if (gated !== null) {
      return { repeated: false, result: gated };
    }
    return land(request, rewritten.rewrite.landing.plan);
  }

  const planned = await planLanding({
    projectRoot: request.projectRoot,
    assignmentId: required.assignmentId,
    row: read.row,
    commit: required.commit,
    reviewedBase: required.reviewedBase,
  });
  if (planned.status !== "planned") {
    return { repeated: false, result: planned };
  }
  const { plan } = planned.landing;
  const landingId = crypto.randomUUID();

  // A commit that the branch already holds with an equal patch lands nothing and is only accepted.
  if (plan.from === plan.to) {
    return acceptOnce(request, { kind: "record", landingId, intended: false, plan });
  }

  const gated = await readState(request.projectRoot, (db) =>
    candidateGate(db, { assignmentId: required.assignmentId, landing: planned.landing }),
  );
  if (gated !== null) {
    return { repeated: false, result: gated };
  }

  return land(request, plan);
}

/** Records the intent of one planned move, then moves the branch and records the outcome. */
async function land(request: AcceptCall, plan: LandingPlan): Promise<Reported> {
  const intent = await intendOnce(request, crypto.randomUUID(), plan);
  if (intent.result.status !== "landing-intended") {
    return intent;
  }
  return settle(request, { id: intent.result.landingId, plan });
}
