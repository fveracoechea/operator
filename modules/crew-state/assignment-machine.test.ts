import { expect, test } from "bun:test";
import type { AssignmentRow, AssignmentState } from "./assignment.ts";
import type { DirectionRecord } from "./direction.ts";
import { Assignment, type AssignmentFacts, type BlockerFacts } from "./assignment-machine.ts";
import type { ReviewRow } from "./review.ts";
import type { SubmissionRow } from "./submission.ts";

const NOW = "2026-10-04T00:00:00.000Z";

function assignmentRow(state: AssignmentState, kind = "production"): AssignmentRow {
  return {
    id: "assignment-1",
    sourceId: "source-1",
    sourceKey: "1",
    sourceRevision: "r1",
    trackerBinding: null,
    title: "Work",
    kind,
    planningType: null,
    orderIndex: 0,
    approvedScope: "",
    scopeIdentity: null,
    acceptanceRequirements: "[]",
    permissions: "{}",
    fixedInputs: "[]",
    fixedInputsIdentity: "identity",
    state,
    revision: 2,
    registeredAt: NOW,
    updatedAt: NOW,
    withdrawnUnder: null,
  };
}

function reviewRow(state: string): ReviewRow {
  return {
    id: "review-1",
    submissionId: "submission-1",
    snapshotId: null,
    assignmentId: "review-assignment",
    axes: JSON.stringify(["standards", "spec"]),
    state,
    host: null,
    subAgents: null,
    blocker: null,
    reportedAt: null,
    revision: 1,
    createdAt: NOW,
    updatedAt: NOW,
    publishedText: null,
  };
}

function submissionRow(checks: Array<{ name: string; outcome: string }>): SubmissionRow {
  return {
    id: "submission-1",
    assignmentId: "assignment-1",
    attemptId: "attempt-1",
    resultKind: "non-code",
    assignmentRevision: 2,
    sourceRevision: "r1",
    requirementsIdentity: "requirements",
    artifacts: "[]",
    artifactsIdentity: "artifacts",
    checks: JSON.stringify(checks.map((one) => ({ ...one, command: "bun test", detail: "" }))),
    concerns: "[]",
    decisions: "[]",
    behaviorChanges: "null",
    code: null,
    reviewBase: null,
    identity: "submission-identity",
    state: "awaiting-review",
    revision: 1,
    submittedAt: NOW,
    updatedAt: NOW,
  };
}

function claim(
  state: AssignmentState,
  overrides: Partial<AssignmentFacts["claim"]> = {},
): AssignmentFacts["claim"] {
  return {
    row: assignmentRow(state),
    revision: 2,
    live: null,
    offered: "dispatchable",
    ...overrides,
  };
}

function statusOf(decided: { refused: { status: string } } | { next: unknown }): string {
  return "refused" in decided ? decided.refused.status : "next";
}

test("a claim refuses settled work, then a live attempt, then a stale revision, then the frontier", () => {
  const live = { id: "attempt-9" };
  expect(statusOf(Assignment.decide("claim", claim("accepted", { live, revision: 1 })))).toBe(
    "already-accepted",
  );
  expect(statusOf(Assignment.decide("claim", claim("withdrawn", { live })))).toBe("withdrawn");
  expect(Assignment.decide("claim", claim("registered", { live, revision: 1 }))).toEqual({
    refused: { status: "already-claimed", assignmentId: "assignment-1", attemptId: "attempt-9" },
  });
  expect(statusOf(Assignment.decide("claim", claim("registered", { revision: 1 })))).toBe(
    "stale-revision",
  );
  expect(Assignment.decide("claim", claim("registered", { offered: "planning" }))).toEqual({
    refused: { status: "planning-only", assignmentId: "assignment-1", kind: "production" },
  });
  expect(Assignment.decide("claim", claim("invalidated"))).toEqual({
    next: { state: "claimed", closes: {} },
  });
});

test("only claimed work hands a result over", () => {
  // The move closes the cycle the result answers, under the attempt that handed it over.
  expect(Assignment.decide("submit", { row: assignmentRow("claimed"), attemptId: "a-2" })).toEqual({
    next: { state: "awaiting-review", closes: { cycle: "submitted", answeredBy: "a-2" } },
  });
  expect(Assignment.decide("submit", { row: assignmentRow("rework"), attemptId: "a-2" })).toEqual({
    refused: { status: "not-claimed", assignmentId: "assignment-1", state: "rework" },
  });
});

test("an invalidation refuses a review, then a merged commit, and pauses nothing itself", () => {
  const merged = { commit: "c".repeat(40), pullRequest: 7, url: null };
  const invalidate = (row: AssignmentRow, facts: Partial<AssignmentFacts["invalidate"]> = {}) =>
    Assignment.decide("invalidate", { row, revision: 2, merged: null, ...facts });
  expect(statusOf(invalidate(assignmentRow("claimed"), { merged }))).toBe("not-accepted");
  expect(statusOf(invalidate(assignmentRow("accepted", "review"), { merged }))).toBe(
    "review-not-invalidated",
  );
  expect(invalidate(assignmentRow("accepted"), { merged })).toEqual({
    refused: { status: "merged", assignmentId: "assignment-1", ...merged },
  });
  expect(invalidate(assignmentRow("accepted"))).toEqual({
    next: { state: "invalidated", closes: {} },
  });
});

test("the table gives the resume state of paused work, not the recorded consumed state alone", () => {
  const resume = (facts: Partial<AssignmentFacts["resume"]>) =>
    Assignment.decide("resume", {
      row: assignmentRow("paused"),
      consumed: "accepted",
      cause: "resolved",
      submitted: true,
      held: false,
      ...facts,
    });
  expect(resume({})).toEqual({ next: { state: "awaiting-review", closes: {} } });
  expect(resume({ submitted: false })).toEqual({ next: { state: "registered", closes: {} } });
  expect(resume({ cause: "merged" })).toEqual({ next: { state: "accepted", closes: {} } });
  expect(resume({ consumed: "rework" })).toEqual({ next: { state: "rework", closes: {} } });
  expect(statusOf(resume({ held: true }))).toBe("unmoved");
  expect(statusOf(resume({ row: assignmentRow("claimed") }))).toBe("unmoved");
});

test("a pause leaves work an earlier defect paused as it is", () => {
  expect(statusOf(Assignment.decide("pause", { row: assignmentRow("paused") }))).toBe("unmoved");
  expect(Assignment.decide("pause", { row: assignmentRow("accepted") })).toEqual({
    next: { state: "paused", closes: {} },
  });
});

test("a withdrawal closes every open correction, and a finished holder stays as it is", () => {
  const closes = { cycle: "withdrawn", invalidation: "withdrawn", direction: "withdrawn" } as const;
  expect(Assignment.decide("withdraw", { row: assignmentRow("accepted"), as: "item" })).toEqual({
    next: { state: "withdrawn", closes },
  });
  for (const state of ["accepted", "withdrawn"] as const) {
    expect(
      statusOf(Assignment.decide("withdraw", { row: assignmentRow(state), as: "holder" })),
    ).toBe("unmoved");
  }
  expect(Assignment.decide("withdraw", { row: assignmentRow("registered"), as: "holder" })).toEqual(
    { next: { state: "withdrawn", closes } },
  );
});

test("a rewrite reopens only an accepted result", () => {
  expect(Assignment.decide("reopen", { row: assignmentRow("accepted") })).toEqual({
    next: { state: "awaiting-review", closes: {} },
  });
  expect(statusOf(Assignment.decide("reopen", { row: assignmentRow("paused") }))).toBe("unmoved");
});

const common: {
  revision: number;
  attemptId: string | null;
  record: null;
  directions: DirectionRecord[];
  invalidated: string[];
} = {
  revision: 2,
  attemptId: "attempt-1",
  record: null,
  directions: [],
  invalidated: [],
};

test("an acceptance refuses a stale revision, then a direction, then a pause, before its kind", () => {
  const direction: DirectionRecord = {
    directionRequestId: "direction-1",
    assignmentId: "assignment-1",
    limitKind: "rework_cycles",
    limitValue: 3,
    state: "open",
    revision: 1,
    approvalId: null,
    evidence: { used: 3, detail: "", attempted: [] },
    raisedAt: NOW,
    approval: { action: "limit-direction", targets: [], scope: "", requestRevision: "1" },
  };
  const accept = (facts: Partial<typeof common>) =>
    Assignment.decide("accept", {
      ...common,
      ...facts,
      kind: "review",
      row: assignmentRow("registered", "review"),
      question: null,
      live: null,
      review: null,
    } as AssignmentFacts["accept"]);
  expect(statusOf(accept({ revision: 1, invalidated: ["x"] }))).toBe("stale-revision");
  expect(statusOf(accept({ directions: [direction], invalidated: ["x"] }))).toBe(
    "direction-required",
  );
  expect(accept({ invalidated: ["x"] })).toEqual({
    refused: { status: "input-invalidated", assignmentId: "assignment-1", invalidated: ["x"] },
  });
  expect(statusOf(accept({}))).toBe("not-claimed");
});

test("planning work accepts with no attempt, from registered or invalidated, with its record", () => {
  const accept = (state: AssignmentState, facts: object) =>
    Assignment.decide("accept", {
      ...common,
      attemptId: null,
      kind: "planning",
      row: assignmentRow(state, "planning"),
      unmet: [],
      checked: { status: "checked", entries: [] },
      ...facts,
    });
  expect(statusOf(accept("registered", { attemptId: "attempt-1" }))).toBe("attempt-not-expected");
  expect(statusOf(accept("claimed", {}))).toBe("not-claimed");
  expect(statusOf(accept("registered", { unmet: [{ assignmentId: "a", state: "claimed" }] }))).toBe(
    "dependency-pending",
  );
  expect(statusOf(accept("registered", { checked: null }))).toBe("planning-record-required");
  expect(accept("invalidated", {})).toEqual({
    next: { state: "accepted", closes: { invalidation: "resolved" } },
  });
});

test("production work passes its review gates in order, the outside changes last", () => {
  const submission = submissionRow([{ name: "test", outcome: "passed" }]);
  const accept = (produced: object | null, facts: object = {}) =>
    Assignment.decide("accept", {
      ...common,
      kind: "production",
      row: assignmentRow("awaiting-review"),
      question: null,
      submissionId: "submission-1",
      produced: produced === null ? null : { submission, review: null, outside: [], ...produced },
      ...facts,
    } as AssignmentFacts["accept"]);
  expect(statusOf(accept({}, { record: {} }))).toBe("planning-record-not-expected");
  expect(statusOf(accept({}, { attemptId: null }))).toBe("attempt-required");
  expect(statusOf(accept({}, { question: { id: "q", state: "open" } }))).toBe("question-open");
  expect(statusOf(accept(null))).toBe("submission-required");
  expect(statusOf(accept({}, { submissionId: "other" }))).toBe("submission-mismatch");
  expect(accept({})).toEqual({
    refused: {
      status: "review-incomplete",
      assignmentId: "assignment-1",
      reviewId: null,
      state: "none",
      blocker: null,
    },
  });

  const reported = { row: reviewRow("reported"), findings: [], reports: [] };
  expect(statusOf(accept({ review: reported }))).toBe("review-axes-incomplete");
  const reports = ["standards", "spec"].map((axis) => ({ axis, observedChecks: "[]" }));
  const outside = [{ id: "outside-1", disposition: null, security: 1 }];
  const failing = submissionRow([{ name: "test", outcome: "failed" }]);
  expect(statusOf(accept({ submission: failing, outside, review: { ...reported, reports } }))).toBe(
    "checks-unproven",
  );
  expect(accept({ outside, review: { ...reported, reports } })).toEqual({
    refused: {
      status: "outside-changes-undisposed",
      assignmentId: "assignment-1",
      submissionId: "submission-1",
      changeIds: ["outside-1"],
      security: 1,
    },
  });
  expect(accept({ review: { ...reported, reports } })).toEqual({
    next: { state: "accepted", closes: { invalidation: "resolved" } },
  });
});

test("a merged acceptance takes back only an invalidated result and closes its correction", () => {
  expect(
    Assignment.decide("accept", { kind: "merged", row: assignmentRow("invalidated") }),
  ).toEqual({ next: { state: "accepted", closes: { invalidation: "merged", cycle: "merged" } } });
  expect(
    statusOf(Assignment.decide("accept", { kind: "merged", row: assignmentRow("accepted") })),
  ).toBe("not-claimed");
});

test("the frontier files settled, paused, planning, and running work before any dispatch rule", () => {
  const place = (state: string, kind: string, invalidated?: string[], active = false) =>
    Assignment.place({ row: { state, kind }, invalidated, active });
  expect(place("accepted", "production", ["x"])).toBe("accepted");
  expect(place("withdrawn", "review")).toBe("withdrawn");
  expect(place("paused", "planning", ["x"], true)).toEqual([
    { reason: "input_invalidated", invalidated: ["x"] },
  ]);
  expect(place("registered", "planning")).toBe("planning");
  expect(place("claimed", "production", undefined, true)).toBe("active");
  expect(place("registered", "review")).toBe("open");
});

test("the dispatch rules of open work give the first blocker in order", () => {
  const facts: BlockerFacts = {
    row: { state: "awaiting-review", kind: "production" },
    undirected: [{ id: "direction-1", limitKind: "rework_cycles" }],
    reviewAssignmentId: "review-assignment",
    takeOut: [{ assignmentId: "gone", commit: "c" }],
    unmet: [{ assignmentId: "a", state: "claimed" }],
    holders: { holders: [], command: "overlaps" },
    capacity: { limit: 4, productionLimit: 3, openSlots: 0, heldProduction: 3 },
  };
  const reasons = (one: BlockerFacts) => Assignment.blockerOf(one)?.map((b) => b.reason) ?? [];
  expect(reasons(facts)).toEqual(["direction_required"]);
  const rest = { ...facts, undirected: [] };
  expect(reasons(rest)).toEqual(["review_pending"]);
  const registered = { ...rest, row: { state: "registered", kind: "production" } };
  expect(reasons(registered)).toEqual(["take_out_pending"]);
  expect(reasons({ ...registered, takeOut: [] })).toEqual(["dependency_pending"]);
  const ready = { ...registered, takeOut: [], unmet: [] };
  expect(reasons(ready)).toEqual(["crew_at_capacity"]);
  const slot = { ...ready, capacity: { ...ready.capacity, openSlots: 1 } };
  expect(reasons(slot)).toEqual(["review_capacity_reserved"]);
  expect(Assignment.blockerOf({ ...slot, row: { state: "registered", kind: "review" } })).toBe(
    null,
  );
});
