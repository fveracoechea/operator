import { readAssignment } from "./assignment.ts";
import { type GateStartResult, startRun } from "./gate-start.ts";
import { fixedGateOf, integrationBranchOf } from "./integration.ts";
import { candidateKey, type LandingRefusal, planLanding } from "./landing.ts";
import { readState } from "./operations.ts";
import { latestSubmission, reviewedBaseOf, submittedCommit } from "./submission.ts";

export type CandidateStartResult =
  | GateStartResult
  | { status: "unknown-assignment"; assignmentId: string }
  | { status: "candidate-missing"; assignmentId: string; state: string }
  | { status: "landing-lands-nothing"; assignmentId: string; branch: string; landed: string }
  | Exclude<LandingRefusal, { status: "landing-gate-not-passed" | "landing-pending" }>;

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
    };
  });
  if (read.status !== "read") {
    return read;
  }
  const { assignment, submission, commit, reviewedBase, row } = read;
  if (row === null) {
    return {
      status: "integration-branch-missing",
      assignmentId: assignment.id,
      sourceId: assignment.sourceId,
    };
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
