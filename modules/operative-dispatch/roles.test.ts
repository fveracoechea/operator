import { expect, test } from "bun:test";
import { OperativeDispatch } from "./main.ts";
import type { Brief, Snapshot } from "./plan.ts";
import type { BranchReviewBrief } from "./branch-review-brief.ts";
import type { ReviewBrief } from "./review-brief.ts";
import type { ReworkBrief } from "./rework-brief.ts";

// The recorded brief identity covers the brief text, so each role must render the same bytes,
// copy the same inputs in the same order, and permit the same tools as the fixture pins.
const FIXTURE = new URL("./roles.fixture.json", import.meta.url).pathname;

const snapshot: Snapshot = {
  parentWorkspaceId: "w-project",
  selection: { crew: { host: "claude-code", model: "opus", reasoningEffort: "high" } },
  release: { version: "0.4.0", identity: "release-1" },
  installation: { delivery: "jsr", commit: "f".repeat(40), packageVersion: "0.4.0" },
  lock: { name: "bun.lock", state: "present", identity: "lock-1", path: "/project/bun.lock" },
  skills: { identity: "skills-1" },
};

const code = {
  baseCommit: "b".repeat(40),
  resultCommit: "r".repeat(40),
  mergeBase: "b".repeat(40),
  branch: "operator/item-1",
};

const artifacts = [
  {
    name: "notes",
    kind: "path" as const,
    value: "docs/notes.md",
    contentIdentity: "notes-1",
    storedPath: ".operator/store/notes.md",
  },
  {
    name: "answer",
    kind: "value" as const,
    value: "42",
    contentIdentity: "answer-1",
    storedPath: null,
  },
];

const checks = [
  { name: "test", command: "bun test", outcome: "passed" as const, detail: "All passed." },
];

const priorRounds = [
  {
    reviewId: "review-0",
    submissionId: "submission-0",
    submissionIdentity: "submitted-0",
    findings: [
      {
        findingId: "finding-0",
        axis: "spec",
        key: "missing-case",
        severity: "major",
        summary: "A case is missing.",
        disposition: "accepted",
        reason: "It is in scope.",
        delegatedIn: "cycle-0",
      },
    ],
    cycles: [
      {
        cycleId: "cycle-0",
        reason: "findings",
        cycleIndex: 1,
        conflicts: [{ summary: "Two fixes touch one line.", between: ["finding-0", "finding-1"] }],
      },
    ],
  },
];

const answeredQuestions = [
  {
    questionId: "question-1",
    attemptId: "attempt-0",
    question: "Which format?",
    authority: "human-answer",
    exactText: "Use JSON.",
    interpretation: { summary: "JSON output.", directives: ["Write JSON."], appliesTo: ["cli"] },
  },
];

const decisions = [
  { statement: "Keep the flag.", authority: "requirement" as const, reason: "Requirement 1." },
];

const behaviorChanges = [
  { statement: "Prints JSON.", basis: { kind: "question" as const, questionId: "question-1" } },
];

const planningRecords = [
  {
    assignmentId: "planning-1",
    title: "Decide the format",
    record: {
      recordId: "record-1",
      identity: "record-identity-1",
      decisions: ["Use JSON."],
      artifacts: [
        { name: "design", contentIdentity: "design-1", storedPath: ".operator/store/design.md" },
        { name: "again", contentIdentity: "design-1", storedPath: ".operator/store/design.md" },
      ],
    },
  },
  { assignmentId: "planning-0", title: "Older planning", record: null },
];

const base: Brief = {
  assignmentId: "assignment-1",
  assignmentRevision: 2,
  attemptId: "abcdef12-3456-7890-abcd-ef1234567890",
  sourceId: "source-1",
  sourceKey: "fveracoechea/operator#147",
  sourceRevision: "revision-1",
  title: "Print the report",
  kind: "production",
  approvedScope: "Print the report as JSON.",
  acceptanceRequirements: ["It prints JSON.", "It keeps the flag."],
  requirementsIdentity: "requirements-1",
  permissions: {
    writePaths: ["modules/", "README.md"],
    allowedCommands: ["bun test"],
    network: true,
  },
  fixedInputs: [
    { name: "scope", kind: "path", value: "docs/scope.md", contentIdentity: "scope-1" },
    { name: "flag", kind: "value", value: "--json", contentIdentity: null },
    { name: "loose", kind: "path", value: "docs/loose.md", contentIdentity: null },
  ],
  planningRecords,
  rules: {
    submit: [{ refusal: "one_commit", rule: "Make one commit." }],
    report: [{ refusal: "drift", rule: "Report on the fixed subject." }],
  },
  gate: {
    commit: "c".repeat(40),
    commands: [{ name: "quality", line: "bun run quality", timeoutSeconds: 1800 }],
  },
  role: { kind: "production" },
};

const review: ReviewBrief = {
  reviewId: "review-1",
  attemptId: base.attemptId,
  submissionId: "submission-1",
  submissionIdentity: "submitted-1",
  resultKind: "code",
  axes: ["standards", "spec"],
  requiredCoverage: ["diff", "tests"],
  producerAssignmentId: "assignment-0",
  producerTitle: "Print the report",
  assignmentRevision: 2,
  sourceRevision: "revision-1",
  requirementsIdentity: "requirements-1",
  reviewBase: "b".repeat(40),
  code,
  checks,
  concerns: ["The flag name is long."],
  decisions,
  behaviorChanges,
  artifacts,
  spec: { storedPath: ".operator/store/spec.md", contentIdentity: "spec-1" },
  fixedPoint: "b".repeat(40),
  readCommands: ["git diff", "git log"],
  integration: {
    reviewedPatch: { storedPath: ".operator/store/reviewed.diff", contentIdentity: "patch-1" },
    interdiff: { storedPath: ".operator/store/interdiff.diff", contentIdentity: "interdiff-1" },
  },
  basisQuestions: answeredQuestions,
  priorRounds,
  publishes: true,
};

const branchReview: BranchReviewBrief = {
  reviewId: "review-2",
  attemptId: base.attemptId,
  sourceId: "source-1",
  snapshotId: "snapshot-1",
  snapshotIdentity: "snapshot-identity-1",
  baseCommit: "b".repeat(40),
  headCommit: "h".repeat(40),
  commits: [
    {
      assignmentId: "assignment-0",
      sourceKey: "fveracoechea/operator#146",
      title: "Read the report",
      submissionId: "submission-0",
      commit: "1".repeat(40),
    },
  ],
  axes: ["standards", "spec"],
  requiredCoverage: ["diff"],
  specs: [
    { name: "source", storedPath: ".operator/store/source.md", contentIdentity: "source-1" },
    { name: "spec 1", storedPath: ".operator/store/spec-1.md", contentIdentity: "spec-1" },
  ],
  fixedPoint: "b".repeat(40),
  readCommands: ["git diff", "git log"],
  gateCommands: ["bun run quality"],
  earlierReviews: [
    {
      reviewId: "review-1",
      kind: "result",
      subject: "submission-1",
      findings: [
        {
          findingId: "finding-1",
          axis: "standards",
          key: "naming",
          severity: "minor",
          summary: "A name is vague.",
          disposition: "dismissed",
          reason: "It matches the code.",
          targets: ["modules/a.ts"],
        },
      ],
    },
  ],
};

const rework: ReworkBrief = {
  cycleId: "cycle-1",
  reason: "invalidation",
  cycleIndex: 2,
  limit: 3,
  approvalId: "approval-1",
  reviewId: "review-1",
  submissionId: "submission-1",
  submissionIdentity: "submitted-1",
  resultKind: "code",
  corrections: [
    {
      findingId: "finding-1",
      axis: "spec",
      key: "missing-case",
      severity: "major",
      summary: "A case is missing.",
      evidence: "modules/a.ts:10",
      reason: "It is in scope.",
    },
  ],
  conflicts: [{ summary: "Two fixes touch one line.", between: ["finding-1", "finding-2"] }],
  combines: [{ name: "submission-1", revision: "r".repeat(40) }],
  checks,
  code,
  artifacts,
  invalidation: {
    invalidationId: "invalidation-1",
    defect: { summary: "It crashes.", evidence: "stack trace", foundBy: "person" },
    landedCommit: "l".repeat(40),
    startCommit: "l".repeat(40),
  },
  integration: {
    branch: "operator/integration",
    tip: "t".repeat(40),
    commit: "r".repeat(40),
    cause: "conflict",
    paths: ["modules/a.ts"],
    gateRunId: "gate-1",
    replaces: "l".repeat(40),
  },
  rounds: {
    concerns: ["The flag name is long."],
    decisions,
    behaviorChanges,
    answeredQuestions,
    earlier: priorRounds,
  },
};

const briefs: Record<string, Brief> = {
  production: base,
  rework: { ...base, role: { kind: "rework", rework } },
  review: { ...base, kind: "review", gate: null, role: { kind: "review", review } },
  "branch-review": {
    ...base,
    kind: "branch-review",
    gate: null,
    role: { kind: "branch-review", branchReview },
  },
};

function planned(brief: Brief) {
  const outcome = OperativeDispatch.plan({
    projectRoot: "/projects/operator",
    brief,
    snapshot,
    baseCommit: "a".repeat(40),
    branch: null,
    worktreePath: null,
  });
  if (outcome.status !== "planned") throw new Error(`no plan: ${outcome.status}`);
  return outcome.plan;
}

test("each brief role plans the launch that the fixture pins, byte for byte", async () => {
  const plans = Object.fromEntries(
    Object.entries(briefs).map(([role, brief]) => [role, planned(brief)]),
  );
  const text = `${JSON.stringify(plans, null, 2)}\n`;
  if (process.env.WRITE_ROLES_FIXTURE === "1") await Bun.write(FIXTURE, text);

  expect(text).toBe(await Bun.file(FIXTURE).text());
});
