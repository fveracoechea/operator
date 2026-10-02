import { IntegrationBranch } from "../integration-branch/main.ts";
import type { CleanupContext } from "./cleanup-context.ts";
import type { CleanupBlocker } from "./cleanup-report.ts";
import type { CrewReader } from "./database.ts";
import { type IntegrationBranchRow, integrationBranchOf } from "./integration.ts";
import { intendedLandingOf, landingOfSubmission, type LandingRow } from "./landing.ts";
import { submissionOfAttempt, submittedCommit } from "./submission.ts";

/**
 * Why a submitted commit is on no integration branch. A withdrawn assignment lands nothing, and a
 * replaced commit is one whose assignment was accepted through a different submission.
 */
export type UnlandedCause = "withdrawn" | "replaced";

/**
 * The submitted commit of one ended attempt that no recorded landing carries, or null (D3). Only
 * the person removes a checkout that holds one, so `crew next` offers no removal of it,
 * `cleanup show` lists it, and `cleanup remove` refuses it. It reads the crew state alone.
 */
export function unlandedCommitOf(
  db: CrewReader,
  request: { attemptId: string; assignmentState: string },
): { commit: string; cause: UnlandedCause } | null {
  if (request.assignmentState !== "accepted" && request.assignmentState !== "withdrawn") {
    return null;
  }
  const submission = submissionOfAttempt(db, request.attemptId);
  const commit = submission === null ? null : submittedCommit(submission);
  if (submission === null || commit === null) {
    return null;
  }
  if (request.assignmentState === "withdrawn") {
    return { commit, cause: "withdrawn" };
  }
  return landingOfSubmission(db, submission.id) === null ? { commit, cause: "replaced" } : null;
}

/** What the removal of one checkout proves from the integration branch of its source. */
export type LandingProof = {
  /** The recorded landing of the submission of this attempt, or null when it landed nothing. */
  landing: LandingRow | null;
  branch: IntegrationBranchRow | null;
  /**
   * A landing or a rewrite of the same source with no recorded outcome, which recovery settles
   * first.
   */
  openLanding: LandingRow | null;
};

export function landingProofOf(
  db: CrewReader,
  request: { attemptId: string; sourceId: string },
): LandingProof {
  const submission = submissionOfAttempt(db, request.attemptId);
  return {
    landing: submission === null ? null : landingOfSubmission(db, submission.id),
    branch: integrationBranchOf(db, request.sourceId),
    openLanding: intendedLandingOf(db, request.sourceId),
  };
}

/**
 * Proves that the integration branch still holds the accepted result this checkout handed over
 * (ADR 0010). The branch must be at its recorded tip and hold the recorded commit that carries
 * the result. No remote is read, and nothing falls back to a remote, the main branch, or a
 * patch search.
 */
export async function landingBlockers(request: {
  projectRoot: string;
  context: CleanupContext;
}): Promise<CleanupBlocker[]> {
  const { landing, branch, openLanding } = request.context.proof;
  // A rewrite moves the commit of every later landing, so no commit proof holds until it settles.
  if (openLanding !== null) {
    return [
      {
        reason: openLanding.kind === "rewrite" ? "rewrite_pending" : "landing_pending",
        landingId: openLanding.id,
        pendingAssignmentId: openLanding.assignmentId,
      },
    ];
  }
  if (landing === null) {
    return [];
  }
  if (branch === null) {
    return [{ reason: "integration_branch_missing", branch: landing.branch }];
  }

  const held = await IntegrationBranch.holds({
    repoRoot: request.projectRoot,
    name: branch.name,
    recordedTip: branch.recordedTip,
    commit: landing.landedCommit,
  });
  switch (held.status) {
    case "held":
      return [];
    case "tip-moved":
      return [
        {
          reason: "integration_branch_moved",
          branch: branch.name,
          recordedTip: branch.recordedTip,
          found: held.found,
        },
      ];
    case "missing":
      return [{ reason: "integration_branch_missing", branch: branch.name }];
    case "not-held":
      return [
        {
          reason: "landing_not_held",
          branch: branch.name,
          recordedTip: branch.recordedTip,
          commit: landing.landedCommit,
        },
      ];
    default:
      return [{ reason: "integration_branch_unread", branch: branch.name, detail: held.detail }];
  }
}
