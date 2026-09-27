import { expect, test } from "bun:test";
import { planDispatch, type Brief, type Snapshot } from "./plan.ts";

const snapshot: Snapshot = {
  parentWorkspaceId: "w-renabler",
  selection: { crew: { host: "opencode", model: null } },
  release: { version: "0.4.0", identity: "release" },
  lock: { name: null, state: "ready", identity: null, path: null },
  skills: { identity: "skills" },
};

const brief: Brief = {
  assignmentId: "assignment-stable",
  assignmentRevision: 1,
  attemptId: "abcdef12-3456-7890-abcd-ef1234567890",
  sourceId: "github",
  sourceKey: "59",
  sourceRevision: "revision",
  title: "Migrate customer records",
  kind: "production",
  approvedScope: "Migrate customers.",
  acceptanceRequirements: [],
  requirementsIdentity: "requirements",
  permissions: { writePaths: [], allowedCommands: [], network: false },
  fixedInputs: [],
  review: null,
  rework: null,
};

function plan(input: Brief) {
  return planDispatch({
    projectRoot: "/projects/renabler",
    brief: input,
    snapshot,
    baseCommit: "base",
    branch: null,
    worktreePath: null,
    agentHost: "opencode",
    agentKind: "opencode",
  });
}

test("an Operative has readable project, ticket, purpose and role labels while its handle remains stable", () => {
  const first = plan(brief);

  expect(first.parentWorkspaceId).toBe("w-renabler");
  expect(first.workspaceLabel).toContain("Renabler #59 Operative: Migrate customer records");
  expect(first.tabLabel).toContain("#59 Operative: Migrate customer records");
  expect(first.agentLabel).toContain("#59 Operative: Migrate customer records");
  expect(first.agentName).toBe("operative-abcdef12");
  expect(plan(brief)).toEqual(first);
});

test("review and rework labels identify their roles on the same ticket", () => {
  const review = plan({
    ...brief,
    review: {
      reviewId: "review",
      attemptId: brief.attemptId,
      submissionId: "submission",
      submissionIdentity: "result",
      resultKind: "non-code",
      axes: [],
      requiredCoverage: [],
      producerAssignmentId: brief.assignmentId,
      producerTitle: brief.title,
      assignmentRevision: 1,
      sourceRevision: "revision",
      requirementsIdentity: "requirements",
      reviewBase: null,
      code: null,
      checks: [],
      concerns: [],
      decisions: [],
      artifacts: [],
      priorRounds: [],
    },
  });
  const rework = plan({
    ...brief,
    rework: {
      cycleId: "cycle",
      reason: "findings",
      cycleIndex: 1,
      limit: 2,
      approvalId: null,
      instruction: "Fix the result.",
      reviewId: "review",
      submissionId: "submission",
      submissionIdentity: "result",
      resultKind: "non-code",
      corrections: [],
      conflicts: [],
      combines: [],
      checks: [],
      code: null,
      artifacts: [],
    },
  });

  expect(review.workspaceLabel).toContain("#59 Reviewer:");
  expect(rework.workspaceLabel).toContain("#59 Rework Operative:");
  expect(review.agentName).toBe(rework.agentName);
});
