import { ContentIdentity } from "../content-identity/main.ts";
import { IntegrationBranch } from "../integration-branch/main.ts";
import { integrationBranchOf } from "./integration.ts";
import { readState, type StateFailure } from "./operations.ts";
import { openCycleOf } from "./rework.ts";
import { readSubmission, submittedCommit } from "./submission.ts";
import {
  type IntegrationInputs,
  INTERDIFF_INPUT,
  REVIEWED_PATCH_INPUT,
  type StoredCopy,
  SUBMISSION_STORE,
} from "./submission-store.ts";

export type IntegrationInputsRead =
  | { status: "none" }
  | { status: "stored"; inputs: IntegrationInputs }
  | { status: "integration-branch-unread"; attemptId: string; branch: string; detail: string };

/**
 * Stores the reviewed patch and the interdiff from it to the new patch, when one submission
 * answers an integration cycle (ADR 0017). The new commit is a new submission with an ordinary
 * result review, and a conflict resolution can change what unchanged lines mean, so the review
 * reads the whole result, and these show what changed from the patch that was reviewed. Every
 * other submission stores nothing here.
 */
export async function storeIntegrationInputs(request: {
  projectRoot: string;
  attemptId: string;
  assignmentId: string;
  sourceId: string;
  submissionId: string;
  commit: string | null;
}): Promise<IntegrationInputsRead | StateFailure> {
  const read = await readState(request.projectRoot, (db) => {
    const cycle = openCycleOf(db, request.assignmentId);
    const earlier = cycle === null ? null : readSubmission(db, cycle.submissionId);
    return {
      reason: cycle?.reason ?? null,
      reviewed: earlier === null ? null : submittedCommit(earlier),
      branch: integrationBranchOf(db, request.sourceId)?.name ?? "",
    };
  });
  if ("status" in read) {
    return read;
  }
  if (read.reason !== "integration" || read.reviewed === null || request.commit === null) {
    return { status: "none" };
  }

  const compared = await IntegrationBranch.interdiff({
    repoRoot: request.projectRoot,
    reviewed: read.reviewed,
    current: request.commit,
  });
  if (compared.status !== "read") {
    return {
      status: "integration-branch-unread",
      attemptId: request.attemptId,
      branch: read.branch,
      detail: compared.detail,
    };
  }

  const store = async (name: string, text: string): Promise<StoredCopy> => {
    const storedPath = `${SUBMISSION_STORE}/${request.submissionId}/${name}.diff`;
    await Bun.write(`${request.projectRoot}/${storedPath}`, text, { createPath: true });
    return { storedPath, contentIdentity: ContentIdentity.ofText(text) };
  };
  return {
    status: "stored",
    inputs: {
      reviewedPatch: await store(REVIEWED_PATCH_INPUT, compared.reviewedPatch),
      interdiff: await store(INTERDIFF_INPUT, compared.interdiff),
    },
  };
}
