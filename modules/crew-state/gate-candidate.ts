import { readAssignment } from "./assignment.ts";
import { type GateStartResult, startOnStep, startRun } from "./gate-start.ts";
import { fixedGateOf, integrationBranchOf } from "./integration.ts";
import type { LandingRefusal } from "./branch-move.ts";
import { candidateKey, planLanding } from "./landing.ts";
import { replacedLandingOf } from "./landing-record.ts";
import { readState, type StateFailure } from "./operations.ts";
import { planRewrite, rangeGateOf } from "./rewrite.ts";
import { latestSubmission, reviewedBaseOf, submittedCommit } from "./submission.ts";

export type CandidateStartResult =
  | GateStartResult
  | { status: "unknown-assignment"; assignmentId: string }
  | { status: "candidate-missing"; assignmentId: string; state: string }
  | { status: "landing-lands-nothing"; assignmentId: string; branch: string; landed: string }
  | Exclude<
      LandingRefusal,
      { status: "landing-gate-not-passed" | "landing-pending" | "landing-tip-changed" }
    >
  | StateFailure;

/**
 * Starts one gate run on the candidate of one code result: the planned commit of its landing on
 * the recorded tip (ADR 0021). The landing plan gives the same candidate again, so no ref names
 * it, and its key is its tree with the gate declaration fixed on its source. A plan that lands
 * nothing, or that is refused, starts no run.
 */
export async function startCandidateGateRun(request: {
  projectRoot: string;
  requestId: string;
  ownerToken: string;
  assignmentId: string;
  approvalId: string | null;
  runnerLine: (runId: string) => string;
}): Promise<CandidateStartResult> {
  const read = await readState(request.projectRoot, (db) => {
    const assignment = readAssignment(db, request.assignmentId);
    if (assignment === null) {
      return { status: "unknown-assignment" as const, assignmentId: request.assignmentId };
    }
    const submission = latestSubmission(db, assignment.id);
    const commit = submission === null ? null : submittedCommit(submission);
    if (assignment.state !== "awaiting-review" || submission === null || commit === null) {
      return {
        status: "candidate-missing" as const,
        assignmentId: assignment.id,
        state: assignment.state,
      };
    }
    return {
      status: "read" as const,
      assignment,
      submission,
      commit,
      reviewedBase: reviewedBaseOf(db, submission) ?? commit,
      row: integrationBranchOf(db, assignment.sourceId),
      replaced: replacedLandingOf(db, { assignmentId: assignment.id, submissionId: submission.id }),
    };
  });
  if (read.status !== "read") {
    return read;
  }
  const { assignment, submission, commit, reviewedBase, row, replaced } = read;
  if (row === null) {
    return {
      status: "integration-branch-missing",
      assignmentId: assignment.id,
      sourceId: assignment.sourceId,
    };
  }

  // A correction of a landed commit gates its rebuilt range in order, one commit at a time.
  if (replaced !== null) {
    const rewritten = await planRewrite({
      projectRoot: request.projectRoot,
      assignmentId: assignment.id,
      row,
      replaced,
      commit,
      reviewedBase,
    });
    if (rewritten.status !== "planned") {
      return rewritten;
    }
    const gated = await readState(request.projectRoot, (db) => ({
      gate: rangeGateOf(db, rewritten.rewrite),
    }));
    if (!("gate" in gated)) {
      return gated;
    }
    const { rewrite } = rewritten;
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
            sourceId: assignment.sourceId,
            commit: gate.commit,
            key: gate.key,
            commands: fixedGateOf(row).commands,
            subject: {
              kind: "rewrite",
              assignmentId: assignment.id,
              submissionId: submission.id,
              tip: row.recordedTip,
              parent: gate.parent,
            },
            checkoutBase: row.baseCommit,
          },
        }),
    });
  }

  const planned = await planLanding({
    projectRoot: request.projectRoot,
    assignmentId: assignment.id,
    row,
    commit,
    reviewedBase,
  });
  if (planned.status !== "planned") {
    return planned;
  }
  const { plan } = planned.landing;
  if (plan.from === plan.to) {
    return {
      status: "landing-lands-nothing",
      assignmentId: assignment.id,
      branch: plan.name,
      landed: plan.landed,
    };
  }

  return startRun({
    ...request,
    target: {
      sourceId: assignment.sourceId,
      commit: plan.to,
      key: candidateKey(planned.landing),
      commands: fixedGateOf(row).commands,
      subject: {
        kind: "candidate",
        assignmentId: assignment.id,
        submissionId: submission.id,
        tip: plan.from,
      },
      checkoutBase: row.baseCommit,
    },
  });
}
