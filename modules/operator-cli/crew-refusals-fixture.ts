import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CrewState } from "../crew-state/main.ts";
import { GateRunner } from "../gate-runner/main.ts";
import { OperativeDispatch } from "../operative-dispatch/main.ts";
import { OperatorCli } from "./main.ts";

/**
 * One crew-state result that a command answers with a refusal, or with the success it skips to.
 * The result stands in for what `CrewState` returns, so the test reads only the CLI words.
 */
export type RefusalCase = {
  name: string;
  method: string;
  args: string[];
  result: { status: string; [key: string]: unknown };
  // The method returns its result as is, not wrapped with `repeated`.
  bare?: boolean;
  // The command runs from an Operative worktree, so it reads the reference of attempt t1.
  reference?: boolean;
  // The method is a member of `GateRunner`, not of `CrewState`.
  runner?: boolean;
};

/** Every field that some refusal reads, so one result can carry any status. */
const SINK: Record<string, unknown> = {
  assignmentId: "a1",
  state: "st",
  attemptId: "t1",
  questionId: "q1",
  recordedRevision: 3,
  answerId: "an1",
  authority: "operator",
  escalationTriggers: ["x", "y"],
  acknowledgedAt: "2026-01-01",
  issues: ["i1", "i2"],
  path: "p/x",
  source: { id: "s1", revision: "r9", storedPath: "stored/p" },
  sourceId: "src1",
  revision: "r2",
  recorded: "r1",
  entry: 2,
  name: "art",
  found: "fnd",
  dependencies: [{ assignmentId: "a2", state: "ready" }],
  planningType: null,
  blocker: "blk",
  reviewId: "rv1",
  missing: ["standards", "spec"],
  findingIds: ["f1", "f2"],
  submissionId: "sb1",
  changeIds: ["c1", "c2"],
  security: 1,
  checks: [{ name: "n", outcome: "failed", recorded: "passed", axis: "spec", observed: "failed" }],
  directions: [{ directionRequestId: "d1", limitKind: "cycles", limitValue: 3, revision: 4 }],
  invalidated: ["a3"],
  recordedSubmissionId: "sb0",
  cycleId: "cy1",
  reason: "integration",
  names: ["n1", "n2"],
  branch: "br",
  tip: "tip1",
  planned: "pl1",
  stated: "pr1",
  detail: "det",
  operationState: "intended",
  questionRevision: 1,
};

const GATES = ["gate_pending", "gate_running", "gate_failed", "gate_flaky"];

/** Each landing refusal code, with the variants that change its words. */
const LANDING_REFUSALS: Array<Record<string, unknown>> = [
  { status: "integration-branch-missing", assignmentId: "a1", sourceId: "s1" },
  {
    status: "integration-branch-moved",
    assignmentId: "a1",
    branch: "b",
    recordedTip: "t",
    found: null,
    checkedOut: [],
  },
  {
    status: "integration-branch-moved",
    assignmentId: "a1",
    branch: "b",
    recordedTip: "t",
    found: "f",
    checkedOut: ["w1", "w2"],
  },
  {
    status: "integration-branch-checked-out",
    assignmentId: "a1",
    branch: "b",
    worktrees: ["w1"],
  },
  { status: "integration-branch-unread", assignmentId: "a1", branch: "b", detail: "d" },
  {
    status: "landing-conflict",
    assignmentId: "a1",
    branch: "b",
    tip: "t",
    commit: "c",
    paths: ["x", "y"],
  },
  { status: "landing-patch-changed", assignmentId: "a1", branch: "b", tip: "t", commit: "c" },
  ...GATES.map((gate) => ({
    status: "landing-gate-not-passed",
    assignmentId: "a1",
    gate,
    commit: "c",
    tip: "t",
    key: { tree: "tr" },
    runIds: ["g1", "g2"],
  })),
  {
    status: "rewrite-published-range",
    assignmentId: "a1",
    branch: "b",
    commit: "c",
    pullRequest: null,
    url: null,
  },
  {
    status: "rewrite-published-range",
    assignmentId: "a1",
    branch: "b",
    commit: "c",
    pullRequest: 7,
    url: "u",
  },
  {
    status: "rewrite-tracker-recorded",
    assignmentId: "a1",
    branch: "b",
    steps: [{ assignmentId: "a2", step: "resolution", state: "applied" }],
  },
  {
    status: "take-out-pending",
    assignmentId: "a1",
    sourceId: "s1",
    commits: [{ assignmentId: "a2", commit: "c2" }],
  },
  { status: "landing-pending", assignmentId: "a1", landingId: "l1", pendingAssignmentId: "a2" },
  { status: "rebase-pending", assignmentId: "a1", rebaseId: "rb1", planRevision: "pr" },
  { status: "landing-tip-changed", assignmentId: "a1", planned: "p", recordedTip: null },
  { status: "landing-tip-changed", assignmentId: "a1", planned: "p", recordedTip: "rt" },
];

const SHARED = ["state-missing", "unowned", "ownership-stale", "request-input-changed"];
const ASSIGNMENT = ["unknown-assignment", "stale-revision"];
const SOURCE = [
  "source-unreadable",
  "source-not-text",
  "quote-not-in-source",
  "source-assignment-unknown",
  "source-unknown",
  "source-revision-changed",
];

const ACCEPT = [
  "not-claimed",
  "attempt-required",
  "attempt-not-expected",
  "attempt-mismatch",
  "question-open",
  "submission-required",
  "submission-mismatch",
  "invalid-input",
  "artifact-unreadable",
  "artifact-identity-changed",
  "dependency-pending",
  "planning-record-required",
  "planning-record-not-expected",
  "operator-decision-not-allowed",
  "escalation-required",
  "review-incomplete",
  "review-axes-incomplete",
  "findings-undisposed",
  "rework-pending",
  "outside-changes-undisposed",
  "checks-unproven",
  "checks-contradicted",
  "direction-required",
  "input-invalidated",
];

const REWORK = [
  "invalid-input",
  "not-awaiting-review",
  "submission-required",
  "cycle-open",
  "review-not-of-submission",
  "review-not-reported",
  "findings-undisposed",
  "no-corrections",
  "conflict-not-corrected",
  "unknown-check",
  "checks-passed",
  "lands-cleanly",
  "no-landing",
];

const QUESTION = [
  "unknown-question",
  "stale-question-revision",
  "already-answered",
  "escalation-required",
  "question-closed",
  "already-acknowledged",
];

const LAUNCH_REPORT = {
  attemptId: "t1",
  assignmentId: "a1",
  stage: "launched",
  worktreePath: "w/t1",
  branch: "br",
  baseCommit: "bc",
  agentName: "ag",
  agentHost: "claude",
  agentModel: null,
  reasoningEffort: "high",
  operations: [
    { kind: "worktree", state: "succeeded", detail: null },
    { kind: "agent", state: "failed", detail: "d" },
  ],
};

/** Every field that some attempt answer reads, so one result can carry any status. */
const ATTEMPT_SINK: Record<string, unknown> = {
  attemptId: "t1",
  assignmentId: "a1",
  branch: "br",
  recordedTip: "rt",
  found: "fnd",
  checkedOut: ["w1", "w2"],
  requested: "rq",
  base: "bs",
  heldBy: "s2",
  commit: "cm",
  detail: "det",
  gate: { status: "missing", commit: "cm", path: "operator-gate.json" },
  key: { tree: "tr", declarationIdentity: "di" },
  runIds: ["g1", "g2"],
  recorded: "r1",
  computed: "r2",
  drift: [
    { input: "host", recorded: "claude", current: "opencode" },
    { input: "model", recorded: "m1", current: "m2" },
  ],
  stage: "agent",
  operationState: "intended",
  report: LAUNCH_REPORT,
  repeated: false,
  pending: ["worktree", "agent"],
  agentName: "ag",
  paneId: "p1",
  inspection: { identity: "in1", uncommitted: ["x.ts", "y.ts"], commits: ["c1"] },
  reviewId: "rv1",
  limit: 3,
  approval: { action: "direction", scope: "rv1", requestRevision: "4" },
  direction: {
    directionRequestId: "d1",
    revision: 4,
    approval: { action: "direction", scope: "rv1", requestRevision: "4" },
  },
  previousAttemptId: "t0",
  issues: ["i1", "i2"],
  name: "art",
  path: "p/x",
  kind: "grill",
  state: "st",
  recordedRevision: 3,
  recordedIdentity: "ri",
  submissionId: "sb1",
  revision: 2,
  identity: "id1",
  reviewAssignmentId: "a9",
  reviewSourceKey: "rk",
  reworkCycleId: null,
  outsideChanges: 0,
  refusals: [
    {
      reason: "result_not_one_commit",
      rule: "one",
      baseCommit: "bc",
      commits: [{ commit: "c1", parents: [] }],
      statedBase: "sb",
      statedResult: "sr",
    },
    { reason: "uncommitted_work", paths: ["u1", "u2"] },
    { reason: "outside_write_paths", paths: ["o1", "o2"], writePaths: ["w"] },
    { reason: "result_check_not_run", check: "gate", detail: "dt" },
    {
      reason: "behavior_change_basis_missing",
      entries: [
        { position: 1, detail: "d1" },
        { position: 2, detail: "d2" },
      ],
    },
    {
      reason: "project_gate_not_passed",
      rule: "gate",
      gateCommit: "gc",
      commands: [
        { name: "lint", recorded: [] },
        { name: "test", recorded: ["failed", "flaky"] },
      ],
    },
  ],
};

const ATTEMPT_SHARED = [
  ...SHARED,
  "unknown-attempt",
  "attempt-ended",
  "attempt-not-current",
  "not-dispatched",
];

const GATE_READS = [
  { status: "missing", commit: "cm", path: "operator-gate.json" },
  { status: "invalid", commit: "cm", path: "operator-gate.json", issues: ["i1", "i2"] },
  { status: "unread", commit: "cm", path: "operator-gate.json", detail: "dt" },
];

const DISPATCH = [
  "integration-branch-moved",
  "dispatch-base-not-tip",
  "integration-branch-exists",
  "integration-branch-held",
  "integration-branch-unread",
  "base-commit-unread",
  "review-base-changed",
  "correction-base-changed",
  "commit-required",
  "workspace-required",
  "host-unnamed",
  "effort-unsupported",
  "snapshot-unreadable",
  "snapshot-drift",
  "plan-changed",
  "reconciliation-required",
  "stage-failed",
  "stage-uncertain",
  "acknowledged",
  "awaiting-acknowledgement",
];

const REPLACE = [
  "reconciliation-required",
  "writer-live",
  "writer-unknown",
  "inspection-required",
  "inspection-stale",
  "snapshot-unreadable",
  "review-attempt-limit",
  "replaced",
];

const SUBMIT = [
  "invalid-input",
  "reference-mismatch",
  "artifact-unreadable",
  "artifact-identity-changed",
  "integration-branch-unread",
  "result-refused",
  "review-result-not-submitted",
  "planning-only",
  "not-claimed",
  "stale-revision",
  "source-revision-changed",
  "requirements-changed",
  "already-submitted",
  "submitted",
];

function attemptResults(
  statuses: string[],
  extra: Record<string, unknown> = {},
): Array<Record<string, unknown>> {
  return statuses.map((status) => ({ ...ATTEMPT_SINK, ...extra, status }));
}

const mutation = ["--request", "r", "--owner-token", "o"];
const assignment = [...mutation, "--assignment", "a1", "--revision", "1"];
const question = [...mutation, "--question", "q1", "--revision", "1"];

const APPROVAL = { action: "publish", scope: "s1", targets: ["t1", "t2"], requestRevision: "pv1" };

/** A publish plan that ships, and the variants that change its words. */
const PUBLISH_PLANNED = {
  status: "planned",
  sourceId: "s1",
  repository: "o/r",
  publication: 2,
  planRevision: "pv1",
  planPath: "plans/p1.md",
  ships: { remote: { name: "origin" }, target: "main", parts: [{ name: "n1" }, { name: "n2" }] },
  approval: APPROVAL,
  info: { targetTip: "tt", commitsBehind: 3, mergesCleanly: true, unverifiedRules: ["u1"] },
  refusals: [],
  closes: [{ number: 4 }, { number: 6 }],
  headMoved: [{ number: 5 }],
};

const PUBLISH_REFUSED = {
  ...PUBLISH_PLANNED,
  planRevision: null,
  ships: null,
  approval: null,
  info: { targetTip: null, commitsBehind: null, mergesCleanly: null, unverifiedRules: [] },
  refusals: [
    { reason: "source_unfinished", detail: "d1" },
    { reason: "branch_review_missing", detail: "d2" },
  ],
  closes: [],
  headMoved: [],
};

const PUBLISH_PREVIEWS = [
  PUBLISH_PLANNED,
  PUBLISH_REFUSED,
  { ...PUBLISH_PLANNED, info: null },
  { ...PUBLISH_PLANNED, info: { ...PUBLISH_PLANNED.info, mergesCleanly: false } },
];

const PLAN_MOVED = [
  { status: "plan-revision-changed", stated: "pr1", planned: null, planPath: null },
  { status: "plan-revision-changed", stated: "pr1", planned: "pr2", planPath: "plans/p2.md" },
];

const APPROVAL_REQUIRED = {
  status: "approval-required",
  approval: APPROVAL,
  planPath: "plans/p1.md",
};

const STOPPED = [
  { status: "uncertain", detail: "d" },
  { status: "conflict", detail: "d" },
  { status: "failed", detail: "d" },
].flatMap((outcome) =>
  [null, APPROVAL].map((settlement) => ({
    status: "effect-stopped",
    publication: 2,
    effect: { id: "e1", kind: "push", position: 1 },
    outcome,
    settlement,
  })),
);

const PLAN_UNREAD = [
  { status: "unknown-source", sourceId: "s1" },
  { status: "unread", detail: "det" },
];

const FINISHES = [
  { status: "not-finished", detail: "two parts are open" },
  { status: "finished", gateCheckout: "kept", detail: null },
  { status: "finished", gateCheckout: "kept", detail: "dirty" },
  { status: "finished", gateCheckout: "removed", detail: null },
];

const SEEN = [
  { part: 1, number: 7, state: "merged", method: "merge", fault: null, detail: null },
  { part: 2, number: 8, state: "merged", method: "squash", fault: "squashed", detail: "fd" },
  { part: 3, number: 9, state: "open", method: null, fault: null, detail: null },
];

const RECALL_PLANNED = {
  status: "planned",
  sourceId: "s1",
  publication: 2,
  planRevision: "rc1",
  parts: [{ number: 7 }, { number: 8 }],
  replaced: true,
  approval: APPROVAL,
  planPath: "plans/r1.md",
};

const REBASE_PLANNED = {
  status: "planned",
  sourceId: "s1",
  target: { name: "main", tip: "tt" },
  refusals: [],
  places: [],
  branch: "operator/s1",
  planRevision: "rb1",
  from: { base: "b0", tip: "t0" },
  to: { base: "b1", tip: "t1" },
  record: { merged: ["m1"], relanded: ["l1", "l2"], takenOut: [] },
  gate: { status: "passed", commit: "gc", parent: null },
  approval: APPROVAL,
  planPath: "plans/b1.md",
};

const REBASE_REFUSED = {
  ...REBASE_PLANNED,
  branch: null,
  planRevision: null,
  from: null,
  to: null,
  record: null,
  gate: null,
  approval: null,
  refusals: [
    { reason: "integration_branch_moved", detail: "d1" },
    { reason: "rebase_conflict", detail: "d2" },
  ],
};

const REBASE_PREVIEWS = [
  REBASE_PLANNED,
  REBASE_REFUSED,
  { ...REBASE_PLANNED, gate: { status: "failed", commit: "gc", parent: "b1" } },
];

const REBASE_GATES = ["pending", "running", "failed", "flaky"].flatMap((status) =>
  [null, "p1"].map((parent) => ({
    status: "gate-not-passed",
    gate: { status, commit: "gc", parent, key: { tree: "tr" }, runIds: ["g1", "g2"] },
    preview: REBASE_PLANNED,
  })),
);

const REBASED = {
  status: "rebased",
  rebaseId: "rb1",
  branch: "operator/s1",
  from: { base: "b0", tip: "t0" },
  to: { base: "b1", tip: "t1" },
  record: { merged: ["m1"], relanded: ["l1"], takenOut: ["o1"] },
  branchReview: null,
};

/** A registration plan, and the variants that change its words. */
const REGISTRATION_PLAN = {
  source: { id: "s1", change: "unchanged" },
  planRevision: "rg1",
  items: [{ change: "new" }, { change: "new" }, { change: "updated" }, { change: "unchanged" }],
  withdrawals: [],
  skipped: [{}],
  satisfiedBlockers: [{}, {}],
  refusals: [],
  approval: null,
};

const REGISTRATION_PLANS = [
  REGISTRATION_PLAN,
  {
    ...REGISTRATION_PLAN,
    source: { id: "s1", change: "changed" },
    withdrawals: [{}],
    approval: APPROVAL,
  },
  {
    ...REGISTRATION_PLAN,
    approval: APPROVAL,
    refusals: [
      { reason: "blocker_unknown" },
      { reason: "item_unreadable" },
      { reason: "blocker_unknown" },
    ],
  },
];

const STEP_REPORT = {
  step: "completion",
  assignmentId: "a1",
  state: "applied",
  reason: "tracker.completed",
  operationId: "op1",
  provider: "github",
  target: { repository: "o/r", issue: 3 },
  resourceUrl: null,
  writeAttempts: [],
  observations: [{}],
  problems: [],
};

const REVIEW_REPORT = [
  "invalid-input",
  "reference-mismatch",
  "worktree-changed",
  "review-not-assigned",
  "review-settled",
  "submission-drift",
  "snapshot-drift",
  "finding-untargeted",
  "cut-not-between-commits",
  "finding-target-unknown",
  "axes-incomplete",
  "axes-not-parallel",
  "host-mismatch",
  "sub-agent-failed",
  "coverage-incomplete",
  "published-text-missing",
  "blocked",
];

const REVIEW_DISPOSE = [
  "invalid-input",
  "review-not-reported",
  "unknown-finding",
  "blocker-not-deferrable",
  "correction-target-required",
  "correction-target-not-expected",
  "correction-target-unknown",
];

/** The fields the review report and dispose answers read, beside the shared sink. */
const REVIEW_SINK = {
  changes: ["p1", "p2"],
  commits: ["c1"],
  findings: [
    {
      findingId: "f1",
      axis: "spec",
      key: "k1",
      targets: ["c1", "c2"],
      severity: "blocker",
      summary: "s1",
      target: "a2",
      allowed: ["a3"],
    },
    {
      findingId: "f2",
      axis: "standards",
      key: "k2",
      targets: [],
      severity: "note",
      summary: "s2",
      target: "a4",
      allowed: [],
    },
  ],
  cuts: [1],
  windows: [
    { axis: "spec", startedAt: "t1", endedAt: "t2" },
    { axis: "standards", startedAt: "t3", endedAt: "t4" },
  ],
  axes: ["spec"],
  gaps: [{ axis: "spec", missing: ["m1", "m2"] }],
  snapshotId: "sn1",
};

const DISPOSED = {
  disposed: ["f1", "f2"],
  outstanding: ["f3"],
  corrections: ["f1"],
  invalidated: [{ assignmentId: "a2", invalidationId: "iv1", dependents: ["a5", "a6"] }],
};

const OUTSIDE_DISPOSE = [
  "invalid-input",
  "unknown-submission",
  "submission-settled",
  "unknown-outside-change",
  "outside-dispose-refused",
];

const OUTSIDE_SINK = {
  notRemoved: [{ changeId: "c1", path: "p1" }],
  approvalMissing: [{ changeId: "c2", path: "p2", action: "outside-change-keep" }],
  disposed: ["c1", "c2"],
  outstanding: ["c3", "c4"],
};

const RESOLUTION = [
  "planning-body-not-allowed",
  "planning-record-missing",
  "merge-not-observed",
  "code-resolution-body-not-allowed",
  "completion-reason-not-approved",
  "publish-approval-missing",
  "map-amendment-approval-required",
  "resolution-body-required",
  "comment-too-long",
  "artifact-unreadable",
  "artifact-identity-changed",
];

const RESOLUTION_SINK = {
  approvalId: "ap1",
  step: "resolution",
  approval: APPROVAL,
  planPath: "plans/m1.md",
  size: 70000,
  limit: 65536,
};

const publishMutation = [...mutation, "--source", "s1"];

const GATE_KEY = { tree: "tr", declarationIdentity: "di" };

/** A recorded gate run, with each form of a command line. */
const GATE_RUN = {
  runId: "g1",
  sourceId: "s1",
  key: GATE_KEY,
  commit: "cm",
  state: "running",
  commands: [
    { name: "lint", outcome: "passed", reason: null, outputPath: "out/lint" },
    { name: "test", outcome: "failed", reason: "timeout", outputPath: null },
    { name: "build", outcome: null, reason: null, outputPath: null },
  ],
};

/** Every field that some gate start answer reads, so one result can carry any status. */
const GATE_START_SINK: Record<string, unknown> = {
  run: GATE_RUN,
  line: "ln",
  repeated: false,
  detail: "det",
  uncertain: false,
  sourceId: "s1",
  assignmentId: "a1",
  state: "st",
  branch: "br",
  landed: "ld",
  recordedTip: "rt",
  found: "fnd",
  worktrees: ["w1", "w2"],
  commit: "cm",
  tip: "tp",
  paths: ["x", "y"],
  pullRequest: 7,
  steps: [{ assignmentId: "a2", step: "resolution", state: "applied" }],
  key: GATE_KEY,
  runIds: ["g1", "g2"],
  declarationIdentity: "di",
  runId: "g1",
  request: { action: "fresh-gate-series", scope: "s1", targets: ["t1", "t2"] },
  path: "p/x",
  planned: "pl",
  preview: { sourceId: "s1", refusals: [{ reason: "r1" }, { reason: "r2" }], planPath: "pp" },
};

/**
 * Each status of a gate start, in the order of its answer table. The variants below hold the
 * statuses whose `gate` field has another shape.
 */
const GATE_START = [
  "started",
  "runner-not-typed",
  "rebase-refused",
  "nothing-to-take-out",
  "unknown-assignment",
  "candidate-missing",
  "landing-lands-nothing",
  "integration-branch-missing",
  "integration-branch-moved",
  "integration-branch-checked-out",
  "integration-branch-unread",
  "landing-conflict",
  "landing-patch-changed",
  "rewrite-published-range",
  "rewrite-tracker-recorded",
  "unknown-source",
  "commit-unread",
  "gate-passed",
  "nothing-to-gate",
  "gate-running",
  "gate-runner-unknown",
  "fresh-series-not-needed",
  "fresh-series-not-approved",
  "gate-branch-exists",
  "gate-checkout-failed",
  "gate-checkout-unplanned",
  // No answer holds these, so they read as invalid arguments.
  "take-out-pending",
  "rebase-pending",
];

/** The gate start answers whose words change with a field. */
const GATE_START_VARIANTS: Array<Record<string, unknown>> = [
  { status: "started", repeated: true, run: { ...GATE_RUN, commands: [] } },
  { status: "runner-not-typed", uncertain: true },
  {
    status: "rebase-gate-failed",
    gate: { status: "failed", commit: "gc", parent: null, key: GATE_KEY, runIds: ["g1"] },
  },
  {
    status: "rebase-gate-failed",
    gate: { status: "flaky", commit: "gc", parent: "b1", key: GATE_KEY, runIds: ["g1", "g2"] },
  },
  { status: "integration-branch-moved", found: null },
  { status: "rewrite-published-range", pullRequest: null },
  { status: "gate-checkout-failed", uncertain: true },
  ...GATE_READS.map((gate) => ({ status: "project-gate-unusable", gate })),
];

/** Each end of a gate runner. Every status that is not a run end reads as not running. */
const RUNNER_ENDS = ["passed", "failed", "stopped", "running", "state-missing", "unknown-gate-run"];
/** One command, its arguments, and the results it is answered with. */
const COMMANDS: Array<{
  method: string;
  args: string[];
  results: Array<Record<string, unknown>>;
  bare?: boolean;
  reference?: boolean;
  runner?: boolean;
}> = [
  {
    method: "accept",
    args: ["work", "accept", ...assignment],
    results: [
      ...withStatus([...SHARED, ...ASSIGNMENT, ...ACCEPT, ...SOURCE]),
      ...withStatus(
        ["attempt-mismatch", "outside-changes-undisposed", "operator-decision-not-allowed"],
        { attemptId: null, security: 0, planningType: "grill" },
      ),
      ...withStatus(["quote-not-in-source"], {
        source: { id: "s", revision: "r", storedPath: null },
      }),
      ...withStatus(SOURCE, { entry: undefined }),
      ...landingRefused(),
    ],
  },
  {
    method: "rework",
    args: ["work", "rework", ...assignment, "--input", "in.json"],
    results: [...withStatus([...SHARED, ...ASSIGNMENT, ...REWORK]), ...landingRefused()],
  },
  {
    method: "takeOut",
    args: ["work", "take-out", ...mutation, "--source", "s1", "--plan-revision", "pr"],
    results: [
      ...withStatus([...SHARED, "unknown-source", "nothing-to-take-out", "take-out-intended"]),
      ...withStatus(["take-out-plan-changed"], { recorded: ["r1", "r2"] }),
      ...landingRefused(),
    ],
  },
  {
    method: "invalidate",
    args: ["work", "invalidate", ...assignment, "--input", "in.json"],
    results: withStatus([...SHARED, ...ASSIGNMENT, "invalid-input"]),
  },
  {
    method: "claim",
    args: ["work", "claim", ...assignment],
    results: withStatus([...SHARED, ...ASSIGNMENT]),
  },
  {
    method: "answerQuestion",
    args: ["question", "answer", ...question, "--input", "in.json"],
    results: withStatus([...SHARED, "invalid-input", ...QUESTION, ...SOURCE, "unknown-assignment"]),
  },
  {
    method: "escalateQuestion",
    args: ["question", "escalate", ...question, "--input", "in.json"],
    results: withStatus([
      ...SHARED,
      "invalid-input",
      "unknown-question",
      "stale-question-revision",
      "question-closed",
      "delivery-started",
    ]),
  },
  {
    method: "reapplyAnswer",
    args: ["question", "reapply", ...question, "--answer", "an1", "--approval", "ap1"],
    results: withStatus([
      ...SHARED,
      "unknown-question",
      "already-answered",
      "unknown-answer",
      "answer-not-earlier",
    ]),
  },
  {
    method: "deliverAnswer",
    args: ["question", "deliver", ...mutation, "--question", "q1"],
    results: withStatus([
      ...SHARED,
      "unknown-question",
      "already-acknowledged",
      "not-answered",
      "reconciliation-required",
      "delivery-failed",
    ]),
  },
  {
    method: "question",
    args: ["question", "show", "--question", "q1"],
    results: withStatus([...SHARED, "unknown-question"]),
  },
  {
    method: "dispatch",
    args: ["attempt", "dispatch", ...mutation, "--attempt", "t1"],
    bare: true,
    results: [
      ...attemptResults([...ATTEMPT_SHARED, ...DISPATCH]),
      ...attemptResults(["integration-branch-moved"], { found: null, checkedOut: [] }),
      ...attemptResults(["stage-failed", "stage-uncertain", "acknowledged"], {
        report: { ...LAUNCH_REPORT, agentModel: "m1", reasoningEffort: null, operations: [] },
      }),
      ...GATE_READS.map((gate) => ({ ...ATTEMPT_SINK, status: "project-gate-unusable", gate })),
      ...GATES.map((gate) => ({ ...ATTEMPT_SINK, status: "base-gate-not-passed", gate })),
    ],
  },
  {
    method: "replace",
    args: ["attempt", "replace", ...mutation, "--attempt", "t1"],
    bare: true,
    results: [
      ...attemptResults([...ATTEMPT_SHARED, ...REPLACE]),
      ...GATE_READS.map((gate) => ({ ...ATTEMPT_SINK, status: "project-gate-unusable", gate })),
    ],
  },
  {
    method: "submit",
    args: ["attempt", "submit", "--request", "r", "--attempt", "t1", "--input", "in.json"],
    reference: true,
    results: [
      ...attemptResults([...ATTEMPT_SHARED, "not-acknowledged", ...SUBMIT]),
      ...attemptResults(["submitted"], { outsideChanges: 2, reworkCycleId: "cy1" }),
      ...attemptResults(["result-refused"], {
        refusals: [{ reason: "uncommitted_work", paths: ["u1"] }],
      }),
    ],
  },
  {
    method: "planPublish",
    args: ["publish", "plan", "--source", "s1"],
    results: [...withStatus(SHARED), ...PUBLISH_PREVIEWS, ...PLAN_UNREAD],
  },
  {
    method: "publish",
    args: ["publish", "apply", ...publishMutation, "--plan-revision", "pv1"],
    results: [
      ...withStatus(SHARED),
      ...PUBLISH_PREVIEWS.map((preview) => ({ status: "refused", preview })),
      ...PLAN_MOVED,
      APPROVAL_REQUIRED,
      ...STOPPED,
      {
        status: "published",
        publication: 2,
        pullRequests: [
          { part: 1, headName: "n1", number: 7, url: "https://x/7" },
          { part: 2, headName: "n2", number: null, url: null },
        ],
      },
      ...PLAN_UNREAD,
    ],
  },
  {
    method: "publishStatus",
    args: ["publish", "status", ...publishMutation],
    results: [
      ...withStatus(SHARED),
      ...FINISHES.map((finish) => ({
        status: "observed",
        publication: 2,
        seen: SEEN,
        settlements: [],
        finish,
      })),
      {
        status: "observed",
        publication: 2,
        seen: SEEN,
        settlements: [{ part: 2, number: 8, fault: "squashed", detail: "fd", approval: APPROVAL }],
        finish: FINISHES[0],
      },
      { status: "nothing-published", sourceId: "s1" },
      { status: "publish-unsettled", sourceId: "s1", publication: 2 },
      ...PLAN_UNREAD,
    ],
  },
  {
    method: "retargetPublish",
    args: ["publish", "retarget", ...publishMutation, "--part", "2"],
    results: [
      ...withStatus(SHARED),
      { status: "retargeted", part: 2, number: 8, how: "observed" },
      { status: "retargeted", part: 2, number: 8, how: "written" },
      { status: "not-due", part: 2, detail: "Part 1 is open." },
      { status: "stack-fault", part: 2, detail: "Part 1 was squashed." },
      { status: "approval-required", approval: APPROVAL },
      { status: "publish-unsettled", sourceId: "s1" },
      ...STOPPED,
      ...PLAN_UNREAD,
      { status: "refused", preview: PUBLISH_REFUSED },
      ...PLAN_MOVED,
    ],
  },
  {
    method: "planRecall",
    args: ["publish", "recall", "--source", "s1"],
    results: [
      ...withStatus(SHARED),
      RECALL_PLANNED,
      { ...RECALL_PLANNED, replaced: false },
      { status: "nothing-to-recall", sourceId: "s1" },
      ...PLAN_UNREAD,
    ],
  },
  {
    method: "recall",
    args: ["publish", "recall", ...publishMutation, "--plan-revision", "rc1"],
    results: [
      ...withStatus(SHARED),
      RECALL_PLANNED,
      { status: "nothing-to-recall", sourceId: "s1" },
      ...PLAN_MOVED,
      APPROVAL_REQUIRED,
      { status: "recalled", publication: 2, pullRequests: [7, 8], closed: false },
      { status: "recalled", publication: 2, pullRequests: [7, 8], closed: true },
      ...STOPPED,
      ...PLAN_UNREAD,
      { status: "refused", preview: PUBLISH_REFUSED },
    ],
  },
  {
    method: "planRebase",
    args: ["work", "rebase", "--source", "s1", "--base", "b1"],
    results: [
      ...withStatus(["state-missing"]),
      ...REBASE_PREVIEWS,
      { status: "unknown-source", sourceId: "s1" },
    ],
  },
  {
    method: "rebase",
    args: ["work", "rebase", ...publishMutation, "--base", "b1", "--plan-revision", "rb1"],
    results: [
      ...withStatus(SHARED),
      { status: "unknown-source", sourceId: "s1" },
      ...REBASE_PREVIEWS.map((preview) => ({ status: "refused", preview })),
      ...PLAN_MOVED,
      APPROVAL_REQUIRED,
      ...REBASE_GATES,
      { ...REBASE_GATES[0], preview: REBASE_REFUSED },
      { status: "rebase-pending", rebaseId: "rb0", planRevision: "rb0" },
      {
        status: "rebase-stopped",
        rebaseId: "rb1",
        reason: "integration_branch_unread",
        detail: "d",
      },
      {
        status: "rebase-stopped",
        rebaseId: "rb1",
        reason: "integration_branch_moved",
        detail: "d",
      },
      REBASED,
      { ...REBASED, branchReview: { reviewId: "rv1" } },
    ],
  },
  {
    method: "planRegistration",
    args: ["work", "register", "--input", "in.json", "--plan"],
    results: [
      ...withStatus([...SHARED, "invalid-input"]),
      ...REGISTRATION_PLANS.map((plan) => ({ status: "planned", plan, planPath: "plans/g1.md" })),
    ],
  },
  {
    method: "register",
    args: ["work", "register", ...mutation, "--input", "in.json", "--plan-revision", "rg1"],
    results: [
      ...withStatus([...SHARED, "invalid-input"]),
      ...REGISTRATION_PLANS.map((plan) => ({ status: "refused", plan })),
      { status: "approval-required", approval: APPROVAL },
      {
        status: "plan-revision-changed",
        requested: "rg1",
        found: "rg2",
        differences: [{ part: "item", key: "k1", change: "updated" }],
      },
      { status: "plan-revision-changed", requested: "rg1", found: "rg2", differences: null },
    ],
  },
  {
    method: "gateRun",
    args: ["gate", "show", "--run", "g1"],
    results: [...withStatus(["state-missing"]), { status: "unknown-gate-run" }],
  },
  {
    method: "startGateRun",
    args: ["gate", "run", ...mutation, "--source", "s1", "--commit", "cm"],
    bare: true,
    results: [
      ...withStatus(SHARED, GATE_START_SINK),
      ...withStatus(GATE_START, GATE_START_SINK),
      ...GATE_START_VARIANTS.map((variant) => ({ ...GATE_START_SINK, ...variant })),
    ],
  },
  {
    method: "run",
    args: ["gate", "runner", "--run", "g1", "--root", "root"],
    bare: true,
    runner: true,
    results: RUNNER_ENDS.map((status) => ({ status, lines: ["Runner line.", "Wake check: ok"] })),
  },
  {
    method: "report",
    args: ["review", "report", "--request", "r", "--review", "rv1", "--input", "in.json"],
    reference: true,
    results: [
      ...withStatus([...SHARED, ...REVIEW_REPORT], REVIEW_SINK),
      ...withStatus(["sub-agent-host-mismatch"], { ...REVIEW_SINK, stated: ["h1", "h2"] }),
      ...withStatus(["reported"], REVIEW_SINK),
      ...withStatus(["reported"], { ...REVIEW_SINK, snapshotId: null }),
    ],
  },
  {
    method: "dispose",
    args: ["review", "dispose", ...mutation, "--review", "rv1", "--input", "in.json"],
    results: [
      ...withStatus([...SHARED, ...REVIEW_DISPOSE], REVIEW_SINK),
      ...withStatus(["disposed"], { ...REVIEW_SINK, ...DISPOSED }),
      ...withStatus(["disposed"], {
        ...REVIEW_SINK,
        ...DISPOSED,
        outstanding: [],
        corrections: [],
      }),
    ],
  },
  {
    method: "disposeOutside",
    args: ["work", "dispose", ...mutation, "--submission", "sb1", "--input", "in.json"],
    results: [
      ...withStatus([...SHARED, ...OUTSIDE_DISPOSE], OUTSIDE_SINK),
      ...withStatus(["outside-dispose-refused"], { ...OUTSIDE_SINK, notRemoved: [] }),
      ...withStatus(["outside-dispose-refused"], { ...OUTSIDE_SINK, approvalMissing: [] }),
      ...withStatus(["disposed"], OUTSIDE_SINK),
      ...withStatus(["disposed"], { ...OUTSIDE_SINK, outstanding: [] }),
    ],
  },
  {
    method: "recordTracker",
    args: ["tracker", "record", ...assignment, "--input", "in.json"],
    results: withStatus([...SHARED, "invalid-input", ...RESOLUTION], RESOLUTION_SINK),
  },
  {
    method: "recoverTracker",
    args: ["tracker", "recover", ...mutation, "--operation", "op1"],
    results: [
      ...FINISHES.map((finish) => ({ status: "reported", report: STEP_REPORT, finish })),
      { status: "reported", report: { ...STEP_REPORT, step: "resolution" }, finish: null },
    ],
  },
];

function withStatus(
  statuses: string[],
  extra: Record<string, unknown> = {},
): Array<Record<string, unknown>> {
  return statuses.map((status) => ({ ...SINK, ...extra, status }));
}

function landingRefused(): Array<Record<string, unknown>> {
  return LANDING_REFUSALS.map((refusal) => ({ status: "landing-refused", refusal }));
}

/** Every case, as text and as JSON, each with a name that is unique and stable. */
export function refusalCases(): Array<RefusalCase & { json: boolean }> {
  return COMMANDS.flatMap(({ method, args, results, bare, reference, runner }) =>
    results.flatMap((result, index) =>
      [false, true].map((json) => ({
        name: `${method} ${index} ${String(result.status)}${json ? " --json" : ""}`,
        method,
        args: json ? [...args, "--json"] : args,
        result: { ...result, status: String(result.status) },
        bare,
        reference,
        runner,
        json,
      })),
    ),
  );
}

/** What a person or an agent reads from one command, and the exit code it ends with. */
export type Answered = { lines: string[]; exitCode: number | null };

/**
 * Runs one command through the CLI interface with `CrewState` answering the case result. The
 * command runs in an empty project, so no release selection or crew state is read.
 */
export async function answerOf(one: RefusalCase): Promise<Answered> {
  const methods: Record<string, unknown> = one.runner === true ? GateRunner : CrewState;
  const original = methods[one.method];
  const readReference = OperativeDispatch.readReference;
  const log = console.log;
  const cwd = process.cwd();
  const project = mkdtempSync(join(tmpdir(), "operator-refusals-"));
  writeFileSync(join(project, "in.json"), "{}");
  const lines: string[] = [];
  methods[one.method] = async () =>
    one.bare === true ? one.result : { repeated: false, result: one.result };
  if (one.reference === true) {
    OperativeDispatch.readReference = async () => ({
      controllingCheckout: project,
      assignmentId: "a1",
      attemptId: "t1",
      branch: "br",
      baseCommit: "bc",
      worktreePath: project,
    });
  }
  console.log = (...parts: unknown[]) => {
    lines.push(parts.map(String).join(" "));
  };
  process.exitCode = undefined;
  process.chdir(project);
  try {
    await OperatorCli.main(one.args);
    const code = process.exitCode;
    return { lines, exitCode: code === undefined ? null : Number(code) };
  } finally {
    process.chdir(cwd);
    console.log = log;
    methods[one.method] = original;
    OperativeDispatch.readReference = readReference;
    process.exitCode = 0;
    rmSync(project, { recursive: true, force: true });
  }
}
