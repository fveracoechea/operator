import { expect, test } from "bun:test";
import { planDispatch, type Brief, type Snapshot } from "./plan.ts";
import type { ReviewBrief } from "./review-brief.ts";

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
  rules: { submit: [], report: [] },
  gate: null,
  review: null,
  rework: null,
};

const protocolBrief: Brief = {
  assignmentId: "assignment-1",
  assignmentRevision: 1,
  attemptId: "attempt-1",
  sourceId: "source-1",
  sourceKey: "key-1",
  sourceRevision: "revision-1",
  title: "Produce a result",
  kind: "production",
  approvedScope: "Produce a result.",
  acceptanceRequirements: [],
  requirementsIdentity: "requirements-1",
  permissions: { writePaths: ["modules/"], allowedCommands: ["bun test"], network: false },
  fixedInputs: [],
  rules: { submit: [], report: [] },
  gate: null,
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

function planned(delivery: "jsr" | "github-source") {
  const snapshot: Snapshot = {
    selection: { crew: { host: "opencode", model: null } },
    release: { version: "0.4.0", identity: "identity-1" },
    installation: {
      delivery,
      commit: "f".repeat(40),
      packageVersion: delivery === "jsr" ? "0.4.0" : null,
    },
    lock: { name: "bun.lock", state: "present", identity: "lock-1", path: "/project/bun.lock" },
    skills: { identity: "skills-1" },
  };
  return planDispatch({
    projectRoot: "/project",
    brief: protocolBrief,
    snapshot,
    baseCommit: "a".repeat(40),
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
      behaviorChanges: [],
      artifacts: [],
      spec: null,
      fixedPoint: null,
      readCommands: [],
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

test("JSR Operative instructions install before acknowledging with the project script", () => {
  const plan = planned("jsr");
  expect(plan.briefText).toContain("bun install --frozen-lockfile");
  expect(plan.briefText).toContain("bun run operator attempt acknowledge --request");
  expect(plan.briefText).toContain("bun run operator attempt submit --request");
  expect(plan.briefText).toContain("bun run operator question raise --request");
  expect(plan.briefText).toContain("bun run operator question acknowledge --request");
  expect(plan.promptText).toContain("bun install --frozen-lockfile");
  expect(plan.promptText).toContain("bun run operator attempt acknowledge --request");
});

test("source Operative instructions use the selected commit", () => {
  const plan = planned("github-source");
  const command = `bunx "github:fveracoechea/operator#${"f".repeat(40)}"`;
  expect(plan.briefText).toContain(`${command} attempt acknowledge --request`);
  expect(plan.promptText).toContain(`${command} attempt acknowledge --request`);
  expect(plan.promptText).not.toContain("bun install --frozen-lockfile");
});

test("a producer brief lists each gate command after the submit rules, and permits it", () => {
  const planned = plan({
    ...protocolBrief,
    gate: {
      commit: "c".repeat(40),
      commands: [{ name: "quality", line: "bun run quality", timeoutSeconds: 1800 }],
    },
  });

  const submit = planned.briefText.indexOf("attempt submit --request");
  const gate = planned.briefText.indexOf(
    "- `quality`: `bun run quality` (time limit 1800 seconds)",
  );
  expect(submit).toBeGreaterThan(-1);
  expect(gate).toBeGreaterThan(submit);
  expect(planned.briefText).toContain(
    `run each command of the project gate at commit ${"c".repeat(40)}`,
  );
  expect(planned.briefText).toContain("raise a question");
  expect(planned.briefText).toContain("Run only these commands:\n- bun test\n- bun run quality\n");
  expect(planned.allowedTools).toContain("Bash(bun run quality:*)");
});

// A host that never asks refuses each tool outside the list, so a producer could not make the
// one commit of its code result (ADR 0006).
const GIT_WRITE_RULES = ["Bash(git status:*)", "Bash(git add:*)", "Bash(git commit:*)"];

test("a producer may stage and commit its result", () => {
  expect(plan(protocolBrief).allowedTools).toEqual(expect.arrayContaining(GIT_WRITE_RULES));
});

test("a reviewer may not stage or commit", () => {
  const review = {
    reviewId: "review-1",
    attemptId: "attempt-1",
    submissionId: "submission-1",
    submissionIdentity: "identity",
    resultKind: "code",
    axes: ["standards", "spec"],
    requiredCoverage: ["diff"],
    producerAssignmentId: "assignment-1",
    producerTitle: "Produce a result",
    assignmentRevision: 1,
    sourceRevision: "revision-1",
    requirementsIdentity: "requirements-1",
    reviewBase: null,
    code: null,
    checks: [],
    concerns: [],
    decisions: [],
    behaviorChanges: [],
    artifacts: [],
    spec: null,
    fixedPoint: null,
    readCommands: [],
    integration: null,
    priorRounds: [],
    publishes: false,
  } satisfies ReviewBrief;
  const tools = plan({ ...protocolBrief, kind: "review", review }).allowedTools;
  for (const rule of GIT_WRITE_RULES) expect(tools).not.toContain(rule);
});
