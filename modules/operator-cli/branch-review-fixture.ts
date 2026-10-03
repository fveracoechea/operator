import { expect } from "bun:test";
import {
  acceptProduction,
  acceptReview,
  commitArtifact,
  type Producer,
  reportBody,
  reportReview,
  startProducer,
  startReviewer,
  submissionBody,
  submit,
  type Workspace,
} from "./review-cycle-fixture.ts";
import { headCommit, requestId as request, runJson } from "./workspace-fixture.ts";

/**
 * A source whose integration branch holds two or three reviewed commits, and its branch reviewer,
 * driven through the real CLI. The branch review tests and the publish tests share it.
 */

export const SIBLING = { key: "22.2", kind: "production" as const, title: "Write the notes" };
// The fixture numbers the items of parent 15 in order, so the second item is issue 1502.
export const SIBLING_ISSUE = 1502;
export const THIRD = { key: "22.3", kind: "production" as const, title: "Write the extra" };
export const THIRD_ISSUE = 1503;

/** Commits, submits, and reviews one result with no finding, and frees its reviewer slot. */
export async function reviewedResult(
  workspace: Workspace,
  producer: Producer,
  options: { text: string; path?: string; worktree: string; behaviorChanges?: unknown[] },
) {
  const artifact = await commitArtifact(workspace, producer, options.text, options.path);
  const submitted = await submit(
    workspace,
    producer,
    submissionBody(producer, artifact, { behaviorChanges: options.behaviorChanges ?? [] }),
  );
  expect(submitted.json.reason).toBe("result_submitted");
  const reviewer = await startReviewer(workspace, producer, submitted.json, artifact.commit, {
    worktreePath: `${workspace.root}/${options.worktree}`,
  });
  const reported = await reportReview(
    workspace,
    reviewer,
    submitted.json.data.reviewId,
    reportBody({ submissionIdentity: submitted.json.data.identity, host: workspace.host }),
  );
  expect(reported.json.reason).toBe("review_reported");
  const freed = await acceptReview(workspace, producer, {
    reviewAssignmentId: submitted.json.data.reviewAssignmentId,
    attemptId: reviewer.attemptId,
    revision: reviewer.revision,
  });
  expect(freed.json.reason).toBe("assignment_accepted");
  return {
    artifact,
    submissionId: submitted.json.data.submissionId as string,
    revision: submitted.json.data.revision as number,
  };
}

/** Claims and dispatches a second item of the producer's source, from the recorded tip. */
export async function startSibling(
  workspace: Workspace,
  producer: Producer,
  key = SIBLING.key,
): Promise<Producer> {
  const assignmentId = producer.dependents.get(key) ?? "";
  const claimed = await runJson(workspace, [
    "work",
    "claim",
    "--request",
    request(),
    "--owner-token",
    producer.ownerToken,
    "--assignment",
    assignmentId,
    "--revision",
    "1",
  ]);
  expect(claimed.json.reason).toBe("assignment_claimed");
  const attemptId = claimed.json.data.attemptId as string;
  const worktreePath = `${workspace.root}/operative-${key.replace(".", "-")}`;
  const dispatched = await runJson(workspace, [
    "attempt",
    "dispatch",
    "--request",
    request(),
    "--owner-token",
    producer.ownerToken,
    "--attempt",
    attemptId,
    "--worktree",
    worktreePath,
  ]);
  await runJson(
    workspace,
    ["attempt", "acknowledge", "--request", request(), "--attempt", attemptId],
    worktreePath,
  );
  return {
    ...producer,
    assignmentId,
    attemptId,
    worktreePath,
    baseCommit: await headCommit(workspace, worktreePath),
    assignmentRevision: claimed.json.data.revision as number,
    dispatched: dispatched.json,
  };
}

export type Registered = {
  reviewId: string;
  assignmentId: string;
  snapshotId: string;
  snapshotIdentity: string;
  headCommit: string;
  round: number;
  direction: {
    approval: { action: string; targets: string[]; scope: string; requestRevision: string };
  } | null;
};

/**
 * Two parallel items of one source, each reviewed and accepted, so the branch is final. A third
 * parallel item is registered too, and accepted when `third` is "accepted".
 */
export async function finalBranch(
  workspace: Workspace,
  options: { third?: "registered" | "accepted"; behaviorChanges?: unknown[] } = {},
) {
  const producer = await startProducer(workspace, undefined, {
    dependents: [
      { ...SIBLING, dependsOn: [], writePaths: ["notes/"] },
      ...(options.third === undefined ? [] : [{ ...THIRD, dependsOn: [], writePaths: ["extra/"] }]),
    ],
  });
  const sibling = await startSibling(workspace, producer);
  const first = await reviewedResult(workspace, producer, {
    text: "# Result\n",
    worktree: "reviewer-first",
    behaviorChanges: options.behaviorChanges ?? [],
  });
  const second = await reviewedResult(workspace, sibling, {
    text: "# Notes\n",
    path: "notes/notes.md",
    worktree: "reviewer-second",
  });
  const acceptedFirst = await acceptProduction(workspace, producer, first);
  expect(acceptedFirst.json.reason).toBe("assignment_accepted");
  const acceptedSecond = await acceptProduction(workspace, sibling, second);
  expect(acceptedSecond.json.reason).toBe("assignment_accepted");
  if (options.third !== "accepted") {
    return { producer, sibling, first, second, acceptedFirst, acceptedSecond };
  }
  const third = await startSibling(workspace, producer, THIRD.key);
  const result = await reviewedResult(workspace, third, {
    text: "# Extra\n",
    path: "extra/extra.md",
    worktree: "reviewer-third",
  });
  const acceptedThird = await acceptProduction(workspace, third, result);
  expect(acceptedThird.json.reason).toBe("assignment_accepted");
  // The last acceptance is the one that registers the branch review.
  return { producer, sibling, first, second, acceptedFirst, acceptedSecond: acceptedThird };
}

/** Claims the branch review, dispatches it with no commit, and acknowledges its brief. */
export async function startBranchReviewer(
  workspace: Workspace,
  producer: Producer,
  registered: Registered,
  worktree: string,
) {
  const claimed = await runJson(workspace, [
    "work",
    "claim",
    "--request",
    request(),
    "--owner-token",
    producer.ownerToken,
    "--assignment",
    registered.assignmentId,
    "--revision",
    "1",
  ]);
  expect(claimed.json.reason).toBe("assignment_claimed");
  const attemptId = claimed.json.data.attemptId as string;
  const worktreePath = `${workspace.root}/${worktree}`;
  const dispatched = await runJson(workspace, [
    "attempt",
    "dispatch",
    "--request",
    request(),
    "--owner-token",
    producer.ownerToken,
    "--attempt",
    attemptId,
    "--worktree",
    worktreePath,
  ]);
  await runJson(
    workspace,
    ["attempt", "acknowledge", "--request", request(), "--attempt", attemptId],
    worktreePath,
  );
  return {
    attemptId,
    worktreePath,
    revision: claimed.json.data.revision as number,
    dispatched: dispatched.json,
  };
}

/** A branch report whose standards axis carries the findings, each with its targets. */
export function branchReport(
  workspace: Workspace,
  snapshotIdentity: string,
  findings: Array<{ key: string; severity: string; targets: string[] }> = [],
  options: { observedChecks?: Array<{ name: string; outcome: string }> } = {},
) {
  const body = reportBody({
    submissionIdentity: "unused",
    host: workspace.host,
    checked: ["diff", "requirements", "checks"],
    observedChecks: options.observedChecks ?? [],
  });
  const { submissionIdentity: _unused, ...rest } = body;
  return {
    ...rest,
    snapshotIdentity,
    reports: rest.reports.map((report) => ({
      ...report,
      findings:
        report.axis === "standards"
          ? findings.map((one) => ({
              key: one.key,
              severity: one.severity,
              summary: `The ${one.key} relation between two commits is wrong.`,
              evidence: "docs/result.md and notes/notes.md",
              targets: one.targets,
            }))
          : [],
    })),
  };
}
