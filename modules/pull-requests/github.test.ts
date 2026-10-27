import { expect, test } from "bun:test";
import { observation } from "./github.ts";

function answer(change: object = {}) {
  return {
    viewer: { login: "owner" },
    repository: {
      defaultBranchRef: { name: "main" },
      viewerDefaultMergeMethod: "SQUASH" as const,
      pullRequest: {
        state: "OPEN" as const,
        baseRefName: "main",
        headRefName: "task/1",
        headRefOid: "abc",
        reviewDecision: null,
        mergeCommit: null,
        reviews: { nodes: [] },
        comments: { nodes: [] },
        reviewThreads: { nodes: [] },
        commits: { nodes: [{ commit: { statusCheckRollup: null } }] },
        ...change,
      },
    },
  };
}

test("a review with the Operator marker is an Operator review, from any account", () => {
  const observed = observation(
    answer({
      reviews: {
        nodes: [
          {
            id: "O",
            state: "COMMENTED",
            body: "<!-- operator-review r1 round 1 -->\n**No blockers**",
            url: "u",
            author: { login: "owner" },
          },
          { id: "M", state: "COMMENTED", body: "Mine.", url: "u", author: { login: "owner" } },
        ],
      },
      comments: {
        nodes: [{ id: "C", body: "<!-- operator-review r1 round 1 -->", url: "u", author: null }],
      },
    }),
  );
  expect(observed.feedback).toMatchObject([
    { id: "O", fromViewer: true, operatorReview: true },
    { id: "M", fromViewer: true, operatorReview: false },
    // Only a review carries the marker. A comment with the same text is not a review.
    { id: "C", operatorReview: false },
  ]);
});

test("feedback keeps its kind, author, viewer flag, thread path, and resolution", () => {
  const observed = observation(
    answer({
      reviewDecision: "APPROVED",
      reviews: { nodes: [{ id: "R", state: "APPROVED", body: "", url: "u", author: null }] },
      comments: { nodes: [{ id: "C", body: "Mine.", url: "u", author: { login: "owner" } }] },
      reviewThreads: {
        nodes: [
          {
            isResolved: false,
            path: "a.ts",
            comments: { nodes: [{ id: "T", body: "Fix.", url: "u", author: { login: "bot" } }] },
          },
          { isResolved: true, path: "b.ts", comments: { nodes: [] } },
        ],
      },
    }),
  );
  expect(observed).toMatchObject({
    state: "OPEN",
    head: "abc",
    base: "main",
    defaultBranch: "main",
    approved: true,
    unresolvedThreads: 1,
    checks: [],
    feedback: [
      { id: "R", kind: "review", author: null, fromViewer: false, reviewState: "APPROVED" },
      { id: "C", kind: "comment", author: "owner", fromViewer: true, path: null },
      { id: "T", kind: "thread_comment", path: "a.ts", threadResolved: false },
    ],
  });
});

test("check runs and status contexts map to pending, passing, or failing", () => {
  function run(name: string, status: string, conclusion: string | null) {
    return { __typename: "CheckRun" as const, name, status, conclusion, detailsUrl: null };
  }
  function status(context: string, state: string) {
    return { __typename: "StatusContext" as const, context, state, targetUrl: "t" };
  }
  const observed = observation(
    answer({
      commits: {
        nodes: [
          {
            commit: {
              statusCheckRollup: {
                contexts: {
                  nodes: [
                    run("running", "IN_PROGRESS", null),
                    run("ok", "COMPLETED", "SUCCESS"),
                    run("skipped", "COMPLETED", "SKIPPED"),
                    ...[
                      "FAILURE",
                      "TIMED_OUT",
                      "CANCELLED",
                      "ACTION_REQUIRED",
                      "STARTUP_FAILURE",
                    ].map((conclusion) => run(conclusion, "COMPLETED", conclusion)),
                    status("s-ok", "SUCCESS"),
                    status("s-wait", "PENDING"),
                    status("s-fail", "FAILURE"),
                    status("s-error", "ERROR"),
                  ],
                },
              },
            },
          },
        ],
      },
    }),
  );
  expect(Object.fromEntries(observed.checks.map((check) => [check.name, check.state]))).toEqual({
    running: "pending",
    ok: "passing",
    skipped: "passing",
    FAILURE: "failing",
    TIMED_OUT: "failing",
    CANCELLED: "failing",
    ACTION_REQUIRED: "failing",
    STARTUP_FAILURE: "failing",
    "s-ok": "passing",
    "s-wait": "pending",
    "s-fail": "failing",
    "s-error": "failing",
  });
  expect(observation(answer({ commits: { nodes: [] } })).checks).toEqual([]);
  expect(
    observation({ ...answer(), repository: { ...answer().repository, defaultBranchRef: null } })
      .defaultBranch,
  ).toBeNull();
});
