import { expect, test } from "bun:test";
import type { BranchSnapshotRow, SnapshotCommit } from "./branch-review.ts";
import type { OutsideChangeRow } from "./outside-changes.ts";
import type { BranchReportInput, DispositionInput } from "./review-input.ts";
import { Review, type ReportSubject } from "./review-machine.ts";
import type { ReviewFindingRow, ReviewRow } from "./review.ts";

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

const published = { title: "T", summary: "S", startHere: "H", mergeDanger: "D", cuts: [] };

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
    expect(Review.decide("withdraw", { row: reviewRow(state) })).toEqual({ next: "withdrawn" });
    expect(Review.decide("reopen", { row: reviewRow(state) })).toEqual({ next: "registered" });
  }
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
