import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CrewState } from "../crew-state/main.ts";
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

/** One command, its arguments, and the results it is answered with. */
const COMMANDS: Array<{
  method: string;
  args: string[];
  results: Array<Record<string, unknown>>;
  bare?: boolean;
  reference?: boolean;
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
  return COMMANDS.flatMap(({ method, args, results, bare, reference }) =>
    results.flatMap((result, index) =>
      [false, true].map((json) => ({
        name: `${method} ${index} ${String(result.status)}${json ? " --json" : ""}`,
        method,
        args: json ? [...args, "--json"] : args,
        result: { ...result, status: String(result.status) },
        bare,
        reference,
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
  const methods: Record<string, unknown> = CrewState;
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
