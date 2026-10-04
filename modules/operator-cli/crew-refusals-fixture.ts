import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CrewState } from "../crew-state/main.ts";
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

const mutation = ["--request", "r", "--owner-token", "o"];
const assignment = [...mutation, "--assignment", "a1", "--revision", "1"];
const question = [...mutation, "--question", "q1", "--revision", "1"];

/** One command, its arguments, and the results it is answered with. */
const COMMANDS: Array<{ method: string; args: string[]; results: Array<Record<string, unknown>> }> =
  [
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
      results: withStatus([
        ...SHARED,
        "invalid-input",
        ...QUESTION,
        ...SOURCE,
        "unknown-assignment",
      ]),
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
  return COMMANDS.flatMap(({ method, args, results }) =>
    results.flatMap((result, index) =>
      [false, true].map((json) => ({
        name: `${method} ${index} ${String(result.status)}${json ? " --json" : ""}`,
        method,
        args: json ? [...args, "--json"] : args,
        result: { ...result, status: String(result.status) },
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
  const log = console.log;
  const cwd = process.cwd();
  const project = mkdtempSync(join(tmpdir(), "operator-refusals-"));
  writeFileSync(join(project, "in.json"), "{}");
  const lines: string[] = [];
  methods[one.method] = async () => ({ repeated: false, result: one.result });
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
    process.exitCode = 0;
    rmSync(project, { recursive: true, force: true });
  }
}
