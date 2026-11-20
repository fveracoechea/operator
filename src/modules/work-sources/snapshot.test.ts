import { expect, test } from "bun:test";
import { z } from "zod";
import { decodeSource } from "./snapshot.ts";
import {
  storedCleanup,
  storedLaunch,
  storedMessage,
  storedObligation,
  storedPromotion,
  storedPullRequest,
  storedQuestion,
  storedReport,
  storedSource,
} from "./source-fixture.ts";

const input = {
  source: {
    id: "one",
    repository: "example/one",
    trackerKey: "APP-1",
    state: "open",
    registeredAt: "now",
    endedAt: null,
    plan: JSON.stringify({
      trackerKey: "APP-1",
      assignments: [
        {
          key: "read",
          trackerKey: "APP-2",
          instructions: "Read.",
          completion: "report",
          resources: "pane",
          dependencies: [],
        },
      ],
    }),
  },
  assignments: [{ sourceId: "one", key: "read", kind: null, completion: "report", state: "ready" }],
  launches: [],
  pullRequests: [],
  reports: [],
  questions: [],
  messages: [],
  obligations: [],
  cleanups: [],
  internalReviews: [],
  handoffs: [],
  internalReviewRounds: [],
  promotions: [],
};
test("decodes persisted plans and strips storage-only assignment fields", () => {
  expect(decodeSource(input)).toMatchObject({
    plan: { trackerKey: "APP-1" },
    assignments: [{ key: "read", completion: "report", state: "ready" }],
  });
  expect(decodeSource(input).assignments[0]).not.toHaveProperty("sourceId");
});
test("rejects malformed plans, unknown states, mismatched parents and assignment sets", () => {
  expect(() => decodeSource({ ...input, source: { ...input.source, plan: "broken" } })).toThrow();
  expect(() => decodeSource({ ...input, source: { ...input.source, state: "unknown" } })).toThrow();
  expect(() =>
    decodeSource({ ...input, source: { ...input.source, trackerKey: "other" } }),
  ).toThrow();
  expect(() => decodeSource({ ...input, assignments: [] })).toThrow();
  expect(() =>
    decodeSource({
      ...input,
      assignments: [
        {
          ...input.assignments[0],
          sourceId: "one",
          key: "other",
          kind: null,
          completion: "report",
          state: "ready",
        },
      ],
    }),
  ).toThrow();
  expect(() =>
    decodeSource({
      ...input,
      assignments: [{ sourceId: "one", key: "read", kind: null, completion: "pr", state: "ready" }],
    }),
  ).toThrow();
});

test("source state and end-time invariants reject incomplete or unpersisted transitions", () => {
  const completed = [
    { sourceId: "one", key: "read", kind: null, completion: "report", state: "completed" },
  ];
  expect(() => decodeSource({ ...input, assignments: completed })).toThrow();
  expect(() =>
    decodeSource({ ...input, source: { ...input.source, state: "finished", endedAt: "later" } }),
  ).toThrow();
  expect(() => decodeSource({ ...input, source: { ...input.source, endedAt: "later" } })).toThrow();
  expect(() =>
    decodeSource({ ...input, source: { ...input.source, state: "reset", endedAt: "later" } }),
  ).toThrow();
  expect(
    decodeSource({
      ...input,
      source: { ...input.source, state: "finished", endedAt: "later" },
      assignments: completed,
    }).state,
  ).toBe("finished");
  expect(
    decodeSource({
      ...input,
      source: { ...input.source, state: "reset", endedAt: "later" },
      assignments: [
        { sourceId: "one", key: "read", kind: null, completion: "report", state: "abandoned" },
      ],
    }).state,
  ).toBe("reset");
});

test("a PR open assignment needs its recorded PR, and only PR work past running has one", () => {
  const plan = JSON.stringify({
    trackerKey: "APP-1",
    assignments: [
      {
        key: "change",
        trackerKey: "APP-3",
        instructions: "Change.",
        completion: "pr",
        resources: "worktree",
        branch: "task/3",
        dependencies: [],
      },
    ],
  });
  const pr = {
    sourceId: "one",
    assignment: "change",
    repository: "example/one",
    number: 7,
    url: "https://github.com/example/one/pull/7",
    branch: "task/3",
    associatedAt: "now",
    progress: "{}",
    waitState: "waiting",
    waitAt: "now",
    waitOwnerPid: null,
    waitLeaseAt: null,
    relay: null,
    waitStopped: false,
    mergedHead: null,
    mergeCommit: null,
    mergedAt: null,
  };
  const launch = {
    id: "launch",
    sourceId: "one",
    assignment: "change",
    attempt: 1,
    state: "running",
    name: "pr-3-change",
    resources: "worktree",
    branch: "task/3",
    host: "opencode",
    model: "m",
    requestedModel: "m",
    reasoningEffort: "medium",
    profile: null,
    release: JSON.stringify({ version: "1" }),
    skills: "[]",
    kind: null,
    herdrSocket: null,
    workspaceId: null,
    tabId: null,
    paneId: null,
    worktreePath: null,
    worktreeWorkspaceId: null,
    startedAt: "now",
    endedAt: null,
    failureReason: null,
    failureDetail: null,
    activity: null,
    activityAt: null,
    internalReview: null,
    ownerPid: null,
    leaseAt: null,
    abandoned: false,
  };
  const source = { ...input.source, plan };
  function row(state: string) {
    return [{ sourceId: "one", key: "change", kind: null, completion: "pr", state }];
  }
  const open = {
    source,
    assignments: row("pr-open"),
    launches: [launch],
    pullRequests: [pr],
    reports: [],
    questions: [],
    messages: [],
    obligations: [],
    cleanups: [],
    internalReviews: [],
    handoffs: [],
    internalReviewRounds: [],
    promotions: [],
  };
  expect(decodeSource(open).pullRequests).toEqual([
    {
      assignment: "change",
      number: 7,
      url: pr.url,
      branch: "task/3",
      associatedAt: "now",
      waitState: "waiting",
      waitAt: "now",
      waitStopped: false,
      mergedHead: null,
      mergeCommit: null,
      mergedAt: null,
      relay: null,
    },
  ]);
  expect(() => decodeSource({ ...open, pullRequests: [] })).toThrow();
  expect(() => decodeSource({ ...open, assignments: row("running") })).toThrow();
  expect(() =>
    decodeSource({ ...open, pullRequests: [{ ...pr, waitState: "unknown" }] }),
  ).toThrow();
  expect(() => decodeSource({ ...open, pullRequests: [{ ...pr, assignment: "other" }] })).toThrow();
});

test("a stored report belongs to a started report assignment and one of its launches", () => {
  const launch = {
    id: "l1",
    sourceId: "one",
    assignment: "read",
    attempt: 1,
    state: "finished",
    name: "report-app-2-read",
    resources: "pane",
    branch: null,
    host: "opencode",
    model: "test/model",
    requestedModel: "test/model",
    reasoningEffort: "medium",
    profile: null,
    release: JSON.stringify({ version: "1.0.0" }),
    skills: "[]",
    kind: null,
    herdrSocket: "/herdr.sock",
    workspaceId: "w1",
    tabId: "w1:t1",
    paneId: "w1:p1",
    worktreePath: null,
    worktreeWorkspaceId: null,
    startedAt: "now",
    endedAt: "later",
    failureReason: null,
    failureDetail: null,
    activity: null,
    activityAt: null,
    internalReview: null,
    ownerPid: null,
    leaseAt: null,
    abandoned: false,
  };
  const report = {
    sourceId: "one",
    assignment: "read",
    number: 1,
    launchId: "l1",
    submittedAt: "now",
    conclusion: "Done.",
    evidence: JSON.stringify(["a.ts:1"]),
    unresolved: "[]",
    decisions: JSON.stringify([{ question: "Q?", answer: "A.", by: "person" }]),
    files: "[]",
    decision: "accepted",
    decidedAt: "later",
    followUp: null,
    cleanupState: "done",
    cleanupDetail: "Closed pane w1:p1.",
  };
  const valid = {
    ...input,
    source: { ...input.source, state: "finished", endedAt: "later" },
    assignments: [
      { sourceId: "one", key: "read", kind: null, completion: "report", state: "completed" },
    ],
    launches: [launch],
    reports: [report],
  };
  expect(decodeSource(valid).reports).toMatchObject([
    { number: 1, evidence: ["a.ts:1"], decisions: [{ by: "person" }], cleanupState: "done" },
  ]);
  for (const reports of [
    [{ ...report, launchId: "other" }],
    [{ ...report, decision: "approved" }],
    [{ ...report, decisions: JSON.stringify([{ question: "Q?", answer: "A.", by: "worker" }]) }],
  ])
    expect(() => decodeSource({ ...valid, reports })).toThrow();
  expect(() => decodeSource({ ...input, launches: [], reports: [report] })).toThrow();
});

test("a merged PR assignment needs its verified merge and its cleanup, and nothing else has them", () => {
  const plan = JSON.stringify({
    trackerKey: "APP-1",
    assignments: [
      {
        key: "change",
        trackerKey: "APP-3",
        instructions: "Change.",
        completion: "pr",
        resources: "worktree",
        branch: "task/3",
        dependencies: [],
      },
    ],
  });
  const pr = {
    sourceId: "one",
    assignment: "change",
    repository: "example/one",
    number: 7,
    url: "u",
    branch: "task/3",
    associatedAt: "now",
    progress: "{}",
    waitState: "reported",
    waitAt: "now",
    waitOwnerPid: null,
    waitLeaseAt: null,
    waitStopped: false,
    mergedHead: "h1",
    mergeCommit: "m1",
    mergedAt: "now",
    relay: null,
  };
  const cleanup = {
    sourceId: "one",
    assignment: "change",
    launchId: "launch",
    step: "pane",
    state: "failed",
    reason: "cleanup_failed",
    detail: "pane: refused",
    updatedAt: "now",
    ownerPid: null,
    leaseAt: null,
    running: false,
  };
  const merged = {
    source: { ...input.source, plan, state: "finished", endedAt: "now" },
    assignments: [
      { sourceId: "one", key: "change", kind: null, completion: "pr", state: "merged" },
    ],
    launches: [],
    pullRequests: [pr],
    reports: [],
    questions: [],
    messages: [],
    obligations: [],
    cleanups: [cleanup],
    internalReviews: [],
    handoffs: [],
    internalReviewRounds: [],
    promotions: [],
  };
  expect(decodeSource(merged).cleanups).toEqual([
    {
      assignment: "change",
      step: "pane",
      state: "failed",
      reason: "cleanup_failed",
      detail: "pane: refused",
      updatedAt: "now",
      running: false,
    },
  ]);
  expect(() => decodeSource({ ...merged, cleanups: [] })).toThrow();
  expect(() => decodeSource({ ...merged, pullRequests: [{ ...pr, mergedHead: null }] })).toThrow();
  expect(() => decodeSource({ ...merged, pullRequests: [{ ...pr, mergeCommit: null }] })).toThrow();
  expect(() => decodeSource({ ...merged, cleanups: [{ ...cleanup, step: null }] })).toThrow();
  expect(() =>
    decodeSource({ ...merged, cleanups: [{ ...cleanup, assignment: "other" }] }),
  ).toThrow();
  const open = {
    ...merged,
    source: { ...merged.source, state: "open", endedAt: null },
    assignments: [
      { sourceId: "one", key: "change", kind: null, completion: "pr", state: "pr-open" },
    ],
  };
  expect(() => decodeSource(open)).toThrow();
  expect(() =>
    decodeSource({ ...open, pullRequests: [{ ...pr, mergedHead: null, mergeCommit: null }] }),
  ).toThrow();
  expect(
    decodeSource({
      ...open,
      pullRequests: [{ ...pr, mergedHead: null, mergeCommit: null }],
      cleanups: [],
      internalReviews: [],
      handoffs: [],
      internalReviewRounds: [],
      promotions: [],
    }).assignments,
  ).toEqual([{ key: "change", completion: "pr", state: "pr-open" }]);
});

test("a promoted PR assignment joins the plan with the accepted report as its dependency", () => {
  // The person's words for the report also state what the promoted PR must do.
  const intent = "Find out why the merge is slow, then fix it.";
  const read = storedSource([{ key: "read", completion: "report", state: "completed", intent }], {
    launches: [
      storedLaunch("read", { state: "finished", worktreePath: "/worktrees/read" }),
      storedLaunch("build", { resources: "worktree", worktreePath: "/worktrees/read" }),
    ],
    reports: [storedReport("read", { decision: "accepted", cleanupState: "done" })],
  });
  const { assignment, promotion } = storedPromotion("read", "build");
  const valid = {
    ...read,
    assignments: [...read.assignments, assignment],
    promotions: [promotion],
  };
  const decoded = decodeSource(valid);
  expect(decoded.plan.assignments.map((row) => row.key)).toEqual(["read"]);
  expect(decoded.assignments).toEqual([
    { key: "read", completion: "report", state: "completed" },
    { key: "build", completion: "pr", state: "running" },
  ]);
  expect(decoded.planned[1]).toEqual({
    key: "build",
    trackerKey: "APP-build",
    instructions: "Build build.",
    intent,
    profile: undefined,
    dependencies: ["read"],
    completion: "pr",
    kind: null,
    resources: "worktree",
    branch: "task/build",
    internalReview: undefined,
    promotion: {
      assignment: "build",
      report: "read",
      reportNumber: 1,
      trackerKey: "APP-build",
      instructions: "Build build.",
      branch: "task/build",
      internalReview: null,
      worktreePath: "/worktrees/read",
      handoverLaunchId: "l-build",
      promotedAt: "2026-01-04T00:00:00.000Z",
    },
  });
  // A promotion without its row, of a report that is not accepted, or of an unknown report is corrupt.
  for (const change of [
    { promotions: [] },
    { assignments: read.assignments },
    { promotions: [{ ...promotion, report: "other" }] },
    { promotions: [{ ...promotion, reportNumber: 2 }] },
    { reports: [storedReport("read", { decision: "returned" })] },
    {
      assignments: [
        { sourceId: "one", key: "read", kind: null, completion: "report", state: "reported" },
        assignment,
      ],
    },
  ])
    expect(() => decodeSource({ ...valid, ...change })).toThrow();
});

const storedReview = {
  sourceId: "one",
  assignment: "change",
  state: "reviewing",
  implementerLaunchId: "l-change",
  handoffState: "done",
  handoffDetail: null,
  ownerPid: null,
  leaseAt: null,
  handoffRunning: false,
  startedAt: "now",
  updatedAt: "now",
  readyHead: null,
  commentId: null,
  commentUrl: null,
  endedAt: null,
};
const reviewSource = storedSource(
  [
    { key: "change", completion: "pr", state: "pr-open" },
    { key: "other", completion: "pr", state: "pr-open" },
  ],
  {
    launches: [storedLaunch("change"), storedLaunch("other")],
    pullRequests: [storedPullRequest("change"), storedPullRequest("other")],
    internalReviews: [storedReview],
  },
);

test("review records retain each state and handoff state and reject unknown values", () => {
  for (const state of ["reviewing", "ready", "skipped"]) {
    for (const handoffState of ["pending", "failed", "done"]) {
      const decoded = decodeSource({
        ...reviewSource,
        internalReviews: [{ ...storedReview, state, handoffState }],
      });
      expect<unknown>(decoded.internalReviews).toEqual([
        {
          assignment: "change",
          state,
          implementerLaunchId: "l-change",
          handoffState,
          handoffDetail: null,
          handoffRunning: false,
          startedAt: "now",
          updatedAt: "now",
          readyHead: null,
          commentUrl: null,
          endedAt: null,
        },
      ]);
    }
  }
  for (const change of [{ state: "unknown" }, { handoffState: "unknown" }]) {
    expect(() =>
      decodeSource({ ...reviewSource, internalReviews: [{ ...storedReview, ...change }] }),
    ).toThrow(z.ZodError);
  }
});

test("review records and rounds require their matching PR, launch and review parent", () => {
  const round = {
    sourceId: "one",
    assignment: "change",
    number: 1,
    launchId: "l-change",
    head: "head",
    findings: "[]",
    recordedAt: "now",
  };
  expect(
    decodeSource({ ...reviewSource, internalReviewRounds: [round] }).internalReviewRounds,
  ).toEqual([
    {
      assignment: "change",
      number: 1,
      launchId: "l-change",
      head: "head",
      findings: [],
      recordedAt: "now",
    },
  ]);
  for (const change of [
    {
      pullRequests: [storedPullRequest("other")],
      assignments: reviewSource.assignments.map((row) =>
        row.key === "change" ? { ...row, state: "running" } : row,
      ),
    },
    { internalReviews: [{ ...storedReview, implementerLaunchId: "missing" }] },
    { internalReviews: [{ ...storedReview, implementerLaunchId: "l-other" }] },
    { internalReviews: [{ ...storedReview, assignment: "missing" }] },
    { internalReviews: [], internalReviewRounds: [round] },
    { internalReviewRounds: [{ ...round, assignment: "other" }] },
  ])
    expect(() => decodeSource({ ...reviewSource, ...change })).toThrow(z.ZodError);
  expect(
    decodeSource({
      ...reviewSource,
      internalReviews: [
        storedReview,
        { ...storedReview, assignment: "other", implementerLaunchId: "l-other" },
      ],
      internalReviewRounds: [round],
    }).internalReviewRounds[0]?.assignment,
  ).toBe("change");
});

test("round findings preserve axes, severities and trimmed nonempty descriptions", () => {
  const round = {
    sourceId: "one",
    assignment: "change",
    number: 1,
    launchId: "l-change",
    head: "head",
    findings: "[]",
    recordedAt: "now",
  };
  for (const axis of ["Spec", "Standards", "Skills"]) {
    for (const severity of ["blocker", "nice-to-have"]) {
      const finding = {
        axis,
        severity,
        location: "  src/file.ts:42  ",
        claim: "  The check fails.  ",
      };
      expect<unknown>(
        decodeSource({
          ...reviewSource,
          internalReviewRounds: [{ ...round, findings: JSON.stringify([finding]) }],
        }).internalReviewRounds[0]?.findings,
      ).toEqual([{ axis, severity, location: "src/file.ts:42", claim: "The check fails." }]);
    }
  }
  const finding = {
    axis: "Spec",
    severity: "blocker",
    location: "src/file.ts:42",
    claim: "The check fails.",
  };
  for (const change of [
    { axis: "other" },
    { severity: "other" },
    { location: " " },
    { claim: " " },
  ]) {
    expect(() =>
      decodeSource({
        ...reviewSource,
        internalReviewRounds: [{ ...round, findings: JSON.stringify([{ ...finding, ...change }]) }],
      }),
    ).toThrow(z.ZodError);
  }
});

test("kept report cleanup remains a decoded cleanup state", () => {
  const source = storedSource([{ key: "read", completion: "report", state: "reported" }], {
    launches: [storedLaunch("read")],
    reports: [storedReport("read", { cleanupState: "kept" })],
  });
  expect(decodeSource(source).reports[0]?.cleanupState).toBe("kept");
});

test("questions and messages match one launch among unrelated launches", () => {
  const source = storedSource(
    [
      { key: "read", completion: "report", state: "running" },
      { key: "other", completion: "report", state: "running" },
    ],
    {
      launches: [storedLaunch("other"), storedLaunch("read")],
      questions: [storedQuestion("read", { state: "awaiting_person" })],
      messages: [storedMessage("read")],
    },
  );
  expect(decodeSource(source).questions[0]?.state).toBe("awaiting_person");
  expect(decodeSource(source).messages[0]?.assignment).toBe("read");
  expect(() =>
    decodeSource({ ...source, questions: [storedQuestion("read", { launchId: "l-other" })] }),
  ).toThrow(z.ZodError);
  expect(() =>
    decodeSource({ ...source, messages: [storedMessage("read", { launchId: "l-other" })] }),
  ).toThrow(z.ZodError);
});

test.each(["merged", "abandoned"])(
  "%s assignments reject unanswered questions and steering while unrelated active assignments retain them",
  (state) => {
    const source = storedSource(
      [
        { key: "ended", completion: "pr", state },
        { key: "active", completion: "report", state: "running" },
      ],
      {
        launches: [storedLaunch("ended"), storedLaunch("active")],
        pullRequests:
          state === "merged"
            ? [
                storedPullRequest("ended", {
                  mergedHead: "head",
                  mergeCommit: "merge",
                  mergedAt: "now",
                }),
              ]
            : [],
        cleanups: state === "merged" ? [storedCleanup("ended")] : [],
        questions: [storedQuestion("active")],
        messages: [storedMessage("active")],
      },
    );
    expect(decodeSource(source).questions[0]?.assignment).toBe("active");
    expect(decodeSource(source).messages[0]?.assignment).toBe("active");
    expect(() => decodeSource({ ...source, questions: [storedQuestion("ended")] })).toThrow(
      z.ZodError,
    );
    expect(() => decodeSource({ ...source, messages: [storedMessage("ended")] })).toThrow(
      z.ZodError,
    );
  },
);

test("obligations retain their fields and only closed obligations have a close time", () => {
  const source = storedSource([{ key: "read", completion: "report", state: "ready" }]);
  const open = storedObligation("share");
  const closed = storedObligation("done", {
    state: "closed",
    closedAt: "later",
    reference: "https://example.com/review",
  });
  expect(decodeSource({ ...source, obligations: [open, closed] }).obligations).toEqual([
    {
      key: "share",
      kind: "pr-share",
      summary: "Share share in the review thread.",
      reference: null,
      openedAt: "2026-01-03T00:00:00.000Z",
      state: "open",
      closedAt: null,
    },
    {
      key: "done",
      kind: "pr-share",
      summary: "Share done in the review thread.",
      reference: "https://example.com/review",
      openedAt: "2026-01-03T00:00:00.000Z",
      state: "closed",
      closedAt: "later",
    },
  ]);
  for (const obligation of [
    { ...open, closedAt: "later" },
    { ...closed, closedAt: null },
  ]) {
    expect(() => decodeSource({ ...source, obligations: [obligation] })).toThrow(z.ZodError);
  }
});

test("promotions use the matching report's profile and intent rather than the first assignment", () => {
  const source = storedSource(
    [
      { key: "other", completion: "report", state: "completed", intent: "Other intent." },
      { key: "read", completion: "report", state: "completed", intent: "Chosen intent." },
    ],
    {
      launches: [storedLaunch("other"), storedLaunch("read"), storedLaunch("build")],
      reports: [
        storedReport("other", { decision: "accepted" }),
        storedReport("read", { decision: "accepted" }),
      ],
    },
  );
  const { assignment, promotion } = storedPromotion("read", "build");
  const valid = {
    ...source,
    source: {
      ...source.source,
      plan: JSON.stringify({
        trackerKey: "APP-1",
        assignments: [
          {
            key: "other",
            trackerKey: "APP-other",
            instructions: "Other.",
            completion: "report",
            resources: "pane",
            dependencies: [],
            intent: "Other intent.",
            profile: "other-profile",
          },
          {
            key: "read",
            trackerKey: "APP-read",
            instructions: "Read.",
            completion: "report",
            resources: "pane",
            dependencies: [],
            intent: "Chosen intent.",
            profile: "chosen-profile",
          },
        ],
      }),
    },
    assignments: [...source.assignments, assignment],
    promotions: [promotion],
  };
  expect(decodeSource(valid).planned[2]).toMatchObject({
    key: "build",
    intent: "Chosen intent.",
    profile: "chosen-profile",
  });
  expect(() =>
    decodeSource({ ...valid, promotions: [{ ...promotion, report: "missing" }] }),
  ).toThrow(z.ZodError);
  expect(() =>
    decodeSource({
      ...valid,
      assignments: valid.assignments.map((row) =>
        row.key === "read" ? { ...row, state: "running" } : row,
      ),
    }),
  ).toThrow(z.ZodError);
  expect(() =>
    decodeSource({
      ...valid,
      reports: [
        storedReport("other", { decision: "accepted" }),
        storedReport("read", { decision: "returned" }),
      ],
    }),
  ).toThrow(z.ZodError);
});
