import { expect, test } from "bun:test";
import { draftSchema } from "./draft.ts";
import type { PullRequestFacts, Thread } from "./github.ts";
import { chooseCommit, plannedOperations, reconcile } from "./post.ts";
import type { Operation, Round, Row } from "./request.ts";

const h1 = "1".repeat(40);
const h2 = "2".repeat(40);
const h3 = "3".repeat(40);
function thread(change: Partial<Thread> = {}): Thread {
  return {
    id: "T",
    resolved: false,
    resolvedBy: null,
    startedByViewer: true,
    comments: [],
    ...change,
  };
}
function pr(change: Partial<PullRequestFacts> = {}): PullRequestFacts {
  return {
    state: "OPEN",
    head: h2,
    author: "author",
    viewer: "me",
    files: [],
    filesComplete: true,
    requiredChecks: [],
    checksComplete: true,
    threads: [],
    reviews: [],
    comments: [],
    reviewRequests: [],
    ...change,
  };
}
function request(change: Partial<Row>): Row {
  return {
    id: "r1",
    repository: "o/r",
    number: 7,
    url: "u",
    origin: "slack",
    sourceId: null,
    assignment: null,
    state: "reviewing",
    requestedAt: "t",
    endedAt: null,
    launchState: "running",
    launch: null,
    name: "n",
    branch: "b",
    head: h1,
    herdrSocket: null,
    workspaceId: null,
    tabId: null,
    paneId: null,
    worktreePath: null,
    worktreeWorkspaceId: null,
    failureReason: null,
    failureDetail: null,
    ownerPid: null,
    leaseAt: null,
    trigger: null,
    headMoves: 0,
    activityAt: null,
    staleAt: null,
    resolvedThreads: null,
    sync: null,
    cleanupState: null,
    cleanupDetail: null,
    ...change,
  };
}
function draft(commit: string, change: object = {}) {
  return draftSchema.parse({ reviewedCommit: commit, summary: "S.", ...change });
}

test("a draft of the live head posts, and a moved PR moves the reviewer below the limit", () => {
  expect(chooseCommit(request({}), draft(h2), pr())).toEqual({
    kind: "post",
    commit: h2,
    headLimit: null,
  });
  expect(chooseCommit(request({}), draft(h1), pr())).toEqual({ kind: "move", from: h1, to: h2 });
  expect(chooseCommit(request({ headMoves: 2 }), draft(h1), pr())).toMatchObject({ kind: "move" });
  // A request with no reviewer never moves. Its stale draft is refused by the draft check.
  expect(chooseCommit(request({ state: "queued" }), draft(h1), pr())).toEqual({
    kind: "post",
    commit: h2,
    headLimit: null,
  });
});

test("at the limit, only a draft of the reviewer's head posts, with the limit facts", () => {
  expect(chooseCommit(request({ headMoves: 3 }), draft(h1), pr())).toEqual({
    kind: "post",
    commit: h1,
    headLimit: { reviewedCommit: h1, head: h2, moves: 3 },
  });
  expect(chooseCommit(request({ headMoves: 3 }), draft(h3), pr())).toEqual({
    kind: "post",
    commit: h2,
    headLimit: null,
  });
});

const round: Round = {
  requestId: "r1",
  number: 2,
  trigger: "reply",
  reviewedCommit: h2,
  draft: "{}",
  event: "COMMENT",
  body: "",
  marker: "",
  outcome: "pending",
  reviewId: null,
  reviewUrl: null,
  postedAt: null,
  warning: null,
};

test("each reply carries its marker, and only an explanation in a resolved thread reopens it", () => {
  const planned = plannedOperations(
    round,
    draft(h2, {
      threadReplies: [
        { threadId: "A", kind: "acknowledge", body: "Fair." },
        { threadId: "B", kind: "explain", body: "Still open." },
        { threadId: "C", kind: "explain", body: "Still open." },
      ],
    }),
    pr({
      threads: [
        thread({ id: "A", resolved: true }),
        thread({ id: "B", resolved: true }),
        thread({ id: "C" }),
      ],
    }),
  );
  expect(planned.map((operation) => `${operation.threadId} ${operation.kind}`)).toEqual([
    "A reply",
    "B reply",
    "B unresolve",
    "C reply",
  ]);
  expect(planned[0]).toMatchObject({
    state: "pending",
    marker: "<!-- operator-review r1 round 2 thread A -->",
    body: "Fair.\n\n<!-- operator-review r1 round 2 thread A -->",
  });
});

test("a retry marks a reply that GitHub holds and an unresolve that took effect", () => {
  const operations: Operation[] = [
    {
      requestId: "r1",
      round: 2,
      threadId: "A",
      kind: "reply",
      body: "x",
      marker: "MA",
      state: "pending",
      detail: null,
    },
    {
      requestId: "r1",
      round: 2,
      threadId: "B",
      kind: "reply",
      body: "x",
      marker: "MB",
      state: "pending",
      detail: null,
    },
    {
      requestId: "r1",
      round: 2,
      threadId: "B",
      kind: "unresolve",
      body: null,
      marker: null,
      state: "pending",
      detail: null,
    },
    {
      requestId: "r1",
      round: 2,
      threadId: "C",
      kind: "reply",
      body: "x",
      marker: "MC",
      state: "failed",
      detail: "gone",
    },
  ];
  const facts = pr({
    threads: [
      thread({ id: "A", comments: [{ id: "c", author: "me", body: "x\n\nMA", createdAt: "t" }] }),
      thread({ id: "B", resolved: true }),
    ],
  });
  expect(reconcile(operations, facts).map((operation) => operation.state)).toEqual([
    "done",
    "pending",
    "pending",
    "failed",
  ]);
  expect(
    reconcile(operations, pr({ threads: [thread({ id: "B" })] })).map(
      (operation) => operation.state,
    ),
  ).toEqual(["pending", "pending", "done", "failed"]);
});
