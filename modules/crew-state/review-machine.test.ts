import { expect, test } from "bun:test";
import type { BranchSnapshotRow, SnapshotCommit } from "./branch-review.ts";
import type { OutsideChangeRow } from "./outside-changes.ts";
import type { BranchReportInput, DispositionInput } from "./review-input.ts";
import { Review, type ReportSubject } from "./review-machine.ts";
import type { ReviewFindingRow, ReviewRow } from "./review.ts";
import type { SubmissionRow } from "./submission.ts";

const HOST = "claude";
const COMMIT_A = "a".repeat(40);
const COMMIT_B = "b".repeat(40);

function reviewRow(state: string): ReviewRow {
  return {
    id: "review-1",
    submissionId: null,
    snapshotId: "snapshot-1",
    assignmentId: "review-assignment",
    axes: JSON.stringify(["standards", "spec"]),
    state,
    host: null,
    subAgents: null,
    blocker: null,
    reportedAt: null,
    revision: 1,
    createdAt: "2026-10-03T00:00:00.000Z",
    updatedAt: "2026-10-03T00:00:00.000Z",
    publishedText: null,
  };
}

const commits: SnapshotCommit[] = [
  { assignmentId: "item-a", sourceKey: "a", title: "A", submissionId: "s-a", commit: COMMIT_A },
  { assignmentId: "item-b", sourceKey: "b", title: "B", submissionId: "s-b", commit: COMMIT_B },
];

const snapshot: BranchSnapshotRow = {
  id: "snapshot-1",
  sourceId: "source-1",
  baseCommit: "0".repeat(40),
  headCommit: COMMIT_B,
  commits: JSON.stringify(commits),
  identity: "snapshot-identity",
  createdAt: "2026-10-03T00:00:00.000Z",
};

const text = { title: "T", summary: "S", startHere: "H", mergeDanger: "D" };
const published = { ...text, cuts: [] };

function axisReport(axis: "standards" | "spec", targets: string[]) {
  return {
    axis,
    summary: `${axis} read`,
    checked: ["diff", "requirements", "checks"],
    observedChecks: [],
    findings: [
      { key: `${axis}-1`, severity: "improvement" as const, summary: "S", evidence: "E", targets },
    ],
  };
}

function subAgent(axis: "standards" | "spec", startedAt: string, endedAt: string) {
  return {
    axis,
    name: `${axis}-agent`,
    host: HOST,
    startedAt,
    endedAt,
    status: "completed" as const,
  };
}

function reported(change: Partial<Extract<BranchReportInput, { kind: "reported" }>> = {}) {
  const input: BranchReportInput = {
    kind: "reported",
    snapshotIdentity: snapshot.identity,
    host: HOST,
    subAgents: [
      subAgent("standards", "2026-10-03T00:00:00.000Z", "2026-10-03T00:10:00.000Z"),
      subAgent("spec", "2026-10-03T00:01:00.000Z", "2026-10-03T00:09:00.000Z"),
    ],
    reports: [axisReport("standards", [COMMIT_A]), axisReport("spec", [COMMIT_B])],
    published,
    ...change,
  };
  return input;
}

function branch(input: BranchReportInput): ReportSubject {
  return { kind: "branch", snapshot, commits, input };
}

test("a report passes every rule and moves a registered review to reported", () => {
  const decided = Review.decide("report", {
    row: reviewRow("registered"),
    subject: branch(reported()),
    agentHost: HOST,
  });
  expect(decided).toEqual({ next: "reported" });
});

test("a report is refused by the first failed rule, in the order of the table", () => {
  const facts = (state: string, input: BranchReportInput, agentHost = HOST) =>
    Review.decide("report", { row: reviewRow(state), subject: branch(input), agentHost });

  expect(facts("blocked", reported({ snapshotIdentity: "other" }))).toEqual({
    refused: { status: "review-settled", reviewId: "review-1", state: "blocked" },
  });
  expect(facts("registered", reported({ snapshotIdentity: "other" }), "codex")).toEqual({
    refused: {
      status: "snapshot-drift",
      reviewId: "review-1",
      recorded: "snapshot-identity",
      stated: "other",
    },
  });
  expect(facts("registered", reported(), "codex")).toMatchObject({
    refused: { status: "host-mismatch", recorded: "codex", stated: HOST },
  });
  expect(
    facts(
      "registered",
      reported({
        subAgents: [
          subAgent("standards", "2026-10-03T00:00:00.000Z", "2026-10-03T00:01:00.000Z"),
          subAgent("spec", "2026-10-03T00:02:00.000Z", "2026-10-03T00:03:00.000Z"),
        ],
        reports: [axisReport("standards", []), axisReport("spec", [])],
      }),
    ),
  ).toMatchObject({ refused: { status: "axes-not-parallel" } });
  expect(
    facts(
      "registered",
      reported({ reports: [axisReport("standards", []), axisReport("spec", ["c".repeat(40)])] }),
    ),
  ).toEqual({
    refused: {
      status: "finding-untargeted",
      reviewId: "review-1",
      findings: [{ axis: "standards", key: "standards-1" }],
    },
  });
  expect(
    facts(
      "registered",
      reported({
        reports: [axisReport("standards", [COMMIT_A]), axisReport("spec", ["c".repeat(40)])],
      }),
    ),
  ).toEqual({
    refused: {
      status: "finding-target-unknown",
      reviewId: "review-1",
      findings: [{ axis: "spec", key: "spec-1", targets: ["c".repeat(40)] }],
    },
  });
});

/** The content guards of a report, in the order of the table. */
const CONTENT_FAILURES = [
  "axes-incomplete",
  "sub-agent-host-mismatch",
  "sub-agent-failed",
  "axes-not-parallel",
  "coverage-incomplete",
  "finding-untargeted",
  "finding-target-unknown",
  "cut-not-between-commits",
] as const;

type ContentFailure = (typeof CONTENT_FAILURES)[number] | "published-text-missing";

/**
 * One report content that fails exactly the named guards. Each failure changes a part of the
 * report that no other guard reads, so any set of them can fail at once.
 */
function failing(failures: ReadonlySet<ContentFailure>) {
  const has = (one: ContentFailure) => failures.has(one);
  const standards = {
    ...subAgent("standards", "2026-10-03T00:00:00.000Z", "2026-10-03T00:01:00.000Z"),
    host: has("sub-agent-host-mismatch") ? "codex" : HOST,
    status: has("sub-agent-failed") ? ("failed" as const) : ("completed" as const),
  };
  const spec = subAgent(
    "spec",
    has("axes-not-parallel") ? "2026-10-03T00:02:00.000Z" : "2026-10-03T00:00:30.000Z",
    "2026-10-03T00:03:00.000Z",
  );
  const standardsReport = axisReport("standards", has("finding-untargeted") ? [] : [COMMIT_A]);
  const specReport = axisReport(
    "spec",
    has("finding-target-unknown") ? ["c".repeat(40)] : [COMMIT_B],
  );
  return {
    host: HOST,
    // A sub-agent that names the other axis leaves its own axis unstated.
    subAgents: [standards, has("axes-incomplete") ? { ...spec, axis: "standards" as const } : spec],
    reports: [
      has("coverage-incomplete") ? { ...standardsReport, checked: ["diff"] } : standardsReport,
      specReport,
    ],
    // A cut after the last commit falls inside no gap.
    cuts: has("cut-not-between-commits") ? [{ ...text, after: COMMIT_B, reason: "R" }] : [],
    text: has("published-text-missing") ? undefined : text,
  };
}

/** The refusal of each report as one failure after the other is mended, first to last. */
function refusalOrder(
  failures: readonly ContentFailure[],
  decide: (content: ReturnType<typeof failing>) => { refused: { status: string } } | object,
): Array<string | null> {
  return failures.map((_one, index) => {
    const decided = decide(failing(new Set(failures.slice(index))));
    return "refused" in decided ? decided.refused.status : null;
  });
}

test("a report is refused by its first failed content rule, in the order of the table", () => {
  const order = refusalOrder(CONTENT_FAILURES, ({ host, subAgents, reports, cuts }) =>
    Review.decide("report", {
      row: reviewRow("registered"),
      subject: branch({
        kind: "reported",
        snapshotIdentity: snapshot.identity,
        host,
        subAgents,
        reports,
        published: { ...text, cuts },
      }),
      agentHost: HOST,
    }),
  );
  expect(order).toEqual([...CONTENT_FAILURES]);
});

test("a published result review needs its text after every other content rule", () => {
  const submission: SubmissionRow = {
    id: "submission-1",
    assignmentId: "item-a",
    attemptId: "attempt-1",
    resultKind: "code",
    assignmentRevision: 1,
    sourceRevision: "1",
    requirementsIdentity: "requirements-identity",
    artifacts: "[]",
    artifactsIdentity: "artifacts-identity",
    checks: "[]",
    concerns: "[]",
    decisions: "[]",
    behaviorChanges: null,
    code: null,
    reviewBase: null,
    identity: "submission-identity",
    state: "submitted",
    revision: 1,
    submittedAt: "2026-10-03T00:00:00.000Z",
    updatedAt: "2026-10-03T00:00:00.000Z",
  };
  const failures = [
    ...CONTENT_FAILURES.filter((one) => !one.startsWith("finding-") && !one.startsWith("cut-")),
    "published-text-missing" as const,
  ];
  const order = refusalOrder(failures, ({ host, subAgents, reports, text: stated }) =>
    Review.decide("report", {
      row: { ...reviewRow("registered"), submissionId: "submission-1", snapshotId: null },
      subject: {
        kind: "submission",
        submission,
        publishes: true,
        input: {
          kind: "reported",
          submissionIdentity: submission.identity,
          host,
          subAgents,
          reports: reports.map(({ findings, ...report }) => ({
            ...report,
            findings: findings.map(({ targets: _targets, ...one }) => one),
          })),
          published: stated,
        },
      },
      agentHost: HOST,
    }),
  );
  expect(order).toEqual(failures);
});

test("a blocker checks only its subject, because it carries no content", () => {
  const blocked: BranchReportInput = {
    kind: "blocked",
    snapshotIdentity: snapshot.identity,
    host: HOST,
    blocker: { reason: "credentials_missing", detail: "No token." },
  };
  const row = reviewRow("registered");
  expect(Review.decide("block", { row, subject: branch(blocked), agentHost: HOST })).toEqual({
    next: "blocked",
  });
  expect(
    Review.decide("block", { row, subject: branch(blocked), agentHost: "codex" }),
  ).toMatchObject({ refused: { status: "host-mismatch" } });
});

function finding(
  id: string,
  severity: string,
  change: Partial<ReviewFindingRow> = {},
): ReviewFindingRow {
  return {
    id,
    reviewId: "review-1",
    axis: "standards",
    findingKey: id,
    severity,
    summary: "S",
    evidence: "E",
    disposition: null,
    reason: null,
    dispositionEvidence: null,
    followUp: null,
    disposedAt: null,
    recordedAt: "2026-10-03T00:00:00.000Z",
    targets: JSON.stringify([COMMIT_A]),
    correctionTarget: null,
    ...change,
  };
}

test("a disposition is refused in the order of the table, and names each correction target", () => {
  const held = new Map([
    ["f-1", finding("f-1", "blocker")],
    ["f-2", finding("f-2", "improvement")],
  ]);
  const dispose = (
    state: string,
    input: DispositionInput,
    branchCommits: SnapshotCommit[] | null,
  ) => Review.decide("dispose", { row: reviewRow(state), held, input, commits: branchCommits });
  const corrected = (target?: string) => ({
    dispositions: [{ findingId: "f-1", disposition: "corrected" as const, reason: "R", target }],
  });

  expect(dispose("registered", corrected("item-a"), commits)).toEqual({
    refused: { status: "review-not-reported", reviewId: "review-1", state: "registered" },
  });
  expect(
    dispose(
      "reported",
      { dispositions: [{ findingId: "f-9", disposition: "rejected", reason: "R", evidence: "E" }] },
      commits,
    ),
  ).toEqual({ refused: { status: "unknown-finding", reviewId: "review-1", findingIds: ["f-9"] } });
  expect(
    dispose(
      "reported",
      {
        dispositions: [{ findingId: "f-1", disposition: "deferred", reason: "R", followUp: "#1" }],
      },
      commits,
    ),
  ).toEqual({
    refused: { status: "blocker-not-deferrable", reviewId: "review-1", findingIds: ["f-1"] },
  });
  expect(dispose("reported", corrected("item-a"), null)).toEqual({
    refused: {
      status: "correction-target-not-expected",
      reviewId: "review-1",
      findingIds: ["f-1"],
    },
  });
  expect(dispose("reported", corrected(), commits)).toEqual({
    refused: { status: "correction-target-required", reviewId: "review-1", findingIds: ["f-1"] },
  });
  expect(dispose("reported", corrected("item-b"), commits)).toEqual({
    refused: {
      status: "correction-target-unknown",
      reviewId: "review-1",
      findings: [{ findingId: "f-1", target: "item-b", allowed: ["item-a"] }],
    },
  });
  expect(dispose("reported", corrected("item-a"), commits)).toEqual({
    next: { state: "reported", targets: new Map([["f-1", "item-a"]]) },
  });
  expect(dispose("reported", corrected(), null)).toEqual({
    next: { state: "reported", targets: new Map() },
  });
});

test("a reported review is never withdrawn or reopened, and any other review is", () => {
  for (const state of ["registered", "blocked", "withdrawn"]) {
    const result = { ...reviewRow(state), submissionId: "submission-1", snapshotId: null };
    expect(Review.decide("withdraw", { row: result })).toEqual({ next: "withdrawn" });
    expect(Review.decide("reopen", { row: reviewRow(state) })).toEqual({ next: "registered" });
  }
  for (const state of ["registered", "blocked"]) {
    expect(Review.decide("withdraw", { row: reviewRow(state) })).toEqual({ next: "withdrawn" });
  }
  // A withdrawn branch review is already closed, so a repeated withdrawal writes nothing.
  expect(Review.decide("withdraw", { row: reviewRow("withdrawn") })).toEqual({
    next: "unchanged",
  });
  const refused = { refused: { status: "review-reported" as const, reviewId: "review-1" } };
  expect(Review.decide("withdraw", { row: reviewRow("reported") })).toEqual(refused);
  expect(Review.decide("reopen", { row: reviewRow("reported") })).toEqual(refused);
});

const outsideRow: OutsideChangeRow = {
  id: "change-1",
  submissionId: "submission-1",
  place: "git-hooks",
  path: "/repo/.git/hooks/pre-commit",
  change: "added",
  before: null,
  after: "file",
  security: 1,
  disposition: null,
  reason: null,
  evidence: null,
  approvalId: null,
  disposedAt: null,
  recordedAt: "2026-10-03T00:00:00.000Z",
};

test("a review owes one step, read from its state and then from each disposition", () => {
  const owed = (state: string, findings: ReviewFindingRow[], outside = [outsideRow]) =>
    Review.owed({ row: reviewRow(state), findings, outside }).owes;
  const corrected = finding("f-2", "blocker", { disposition: "corrected" });

  expect(owed("blocked", [])).toBe("replace");
  expect(owed("registered", [])).toBe("report");
  expect(owed("withdrawn", [])).toBe("report");
  expect(owed("reported", [finding("f-1", "blocker"), corrected])).toBe("dispose");
  expect(owed("reported", [corrected])).toBe("rework");
  expect(owed("reported", [finding("f-2", "blocker", { disposition: "rejected" })])).toBe(
    "outside",
  );
  expect(owed("reported", [], [{ ...outsideRow, disposition: "explained" }])).toBe("nothing");
});
