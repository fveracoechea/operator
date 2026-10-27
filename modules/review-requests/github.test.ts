import { expect, test } from "bun:test";
import { pullRequestAnswer, pullRequestFacts, pullRequestTarget, reviewEvent } from "./github.ts";

function answer(change: Record<string, unknown> = {}) {
  return pullRequestAnswer.parse({
    data: {
      viewer: { login: "me" },
      repository: {
        pullRequest: {
          state: "OPEN",
          headRefOid: "abc",
          author: { login: "author" },
          files: { totalCount: 1, nodes: [{ path: "a.ts" }] },
          reviewThreads: { nodes: [] },
          reviews: { nodes: [] },
          comments: { nodes: [] },
          timelineItems: { nodes: [] },
          commits: { nodes: [{ commit: { statusCheckRollup: null } }] },
          ...change,
        },
      },
    },
  });
}

test("a PR URL gives a lower-case repository, its number, and a canonical URL", () => {
  expect(pullRequestTarget("https://github.com/Example/One.js/pull/12/")).toEqual({
    repository: "example/one.js",
    number: 12,
    url: "https://github.com/example/one.js/pull/12",
  });
  for (const text of [
    "https://gitlab.com/example/one/pull/1",
    "https://github.com/example/one/issues/1",
    "https://github.com/example/../pull/1",
    "https://github.com/example/one/pull/0",
    "https://github.com/example/one/pull/1/files",
    "http://github.com/example/one/pull/1",
  ])
    expect(pullRequestTarget(text), text).toBeNull();
});

test("only required checks are facts, with failing, passing, and pending states", () => {
  const facts = pullRequestFacts(
    answer({
      commits: {
        nodes: [
          {
            commit: {
              statusCheckRollup: {
                contexts: {
                  totalCount: 7,
                  nodes: [
                    {
                      __typename: "CheckRun",
                      name: "unit",
                      status: "COMPLETED",
                      conclusion: "TIMED_OUT",
                      detailsUrl: "u",
                      isRequired: true,
                    },
                    {
                      __typename: "CheckRun",
                      name: "lint",
                      status: "COMPLETED",
                      conclusion: "SUCCESS",
                      detailsUrl: null,
                      isRequired: true,
                    },
                    {
                      __typename: "CheckRun",
                      name: "build",
                      status: "IN_PROGRESS",
                      conclusion: null,
                      detailsUrl: null,
                      isRequired: true,
                    },
                    {
                      __typename: "CheckRun",
                      name: "extra",
                      status: "COMPLETED",
                      conclusion: "FAILURE",
                      detailsUrl: null,
                      isRequired: false,
                    },
                    {
                      __typename: "StatusContext",
                      context: "ci/legacy",
                      state: "ERROR",
                      targetUrl: "t",
                      isRequired: true,
                    },
                    {
                      __typename: "StatusContext",
                      context: "ci/ok",
                      state: "SUCCESS",
                      targetUrl: null,
                      isRequired: true,
                    },
                    {
                      __typename: "StatusContext",
                      context: "ci/wait",
                      state: "PENDING",
                      targetUrl: null,
                      isRequired: true,
                    },
                  ],
                },
              },
            },
          },
        ],
      },
    }),
  );
  expect(facts?.requiredChecks).toEqual([
    { name: "unit", state: "failing", url: "u" },
    { name: "lint", state: "passing", url: null },
    { name: "build", state: "pending", url: null },
    { name: "ci/legacy", state: "failing", url: "t" },
    { name: "ci/ok", state: "passing", url: null },
    { name: "ci/wait", state: "pending", url: null },
  ]);
});

test("threads, comments, and renewed requests carry the facts that start rounds", () => {
  const facts = pullRequestFacts(
    answer({
      author: null,
      files: { totalCount: 3, nodes: [{ path: "a.ts" }] },
      reviewThreads: {
        nodes: [
          {
            id: "T1",
            isResolved: true,
            resolvedBy: { login: "author" },
            starter: { nodes: [{ author: { login: "me" } }] },
            comments: {
              nodes: [
                {
                  id: "C1",
                  body: "Fix it.",
                  createdAt: "2026-10-01T00:00:00Z",
                  author: { login: "me" },
                },
                {
                  id: "C2",
                  body: "Done.",
                  createdAt: "2026-10-02T00:00:00Z",
                  author: { login: "author" },
                },
              ],
            },
          },
          {
            id: "T2",
            isResolved: false,
            resolvedBy: null,
            starter: { nodes: [{ author: null }] },
            comments: { nodes: [] },
          },
        ],
      },
      comments: {
        nodes: [
          { id: "P1", body: "@me", createdAt: "2026-10-03T00:00:00Z", author: { login: "author" } },
        ],
      },
      timelineItems: {
        nodes: [
          { createdAt: "2026-10-04T00:00:00Z", requestedReviewer: { login: "me" } },
          { createdAt: "2026-10-05T00:00:00Z", requestedReviewer: {} },
          {},
        ],
      },
      reviews: {
        nodes: [
          { id: "R1", url: "r1", body: "mine", state: "APPROVED", author: { login: "me" } },
          {
            id: "R2",
            url: "r2",
            body: "theirs",
            state: "CHANGES_REQUESTED",
            author: { login: "other" },
          },
        ],
      },
    }),
  );
  expect(facts).toMatchObject({
    state: "OPEN",
    head: "abc",
    author: null,
    viewer: "me",
    files: ["a.ts"],
    filesComplete: false,
    requiredChecks: [],
    checksComplete: true,
    threads: [
      {
        id: "T1",
        resolved: true,
        resolvedBy: "author",
        startedByViewer: true,
        comments: [
          { id: "C1", author: "me", body: "Fix it.", createdAt: "2026-10-01T00:00:00Z" },
          { id: "C2", author: "author", body: "Done.", createdAt: "2026-10-02T00:00:00Z" },
        ],
      },
      { id: "T2", resolved: false, resolvedBy: null, startedByViewer: false, comments: [] },
    ],
    comments: [{ id: "P1", author: "author", body: "@me", createdAt: "2026-10-03T00:00:00Z" }],
    // A team request names no user, so only the user request is a fact.
    reviewRequests: [{ reviewer: "me", createdAt: "2026-10-04T00:00:00Z" }],
    reviews: [
      { id: "R1", event: "APPROVE", byViewer: true },
      { id: "R2", event: "REQUEST_CHANGES", byViewer: false },
    ],
  });
});

test("an unknown answer or a missing PR gives no facts", () => {
  expect(pullRequestAnswer.safeParse({ data: {} }).success).toBe(false);
  expect(
    pullRequestFacts(
      pullRequestAnswer.parse({
        data: { viewer: { login: "me" }, repository: { pullRequest: null } },
      }),
    ),
  ).toBeNull();
});

test("a check list longer than one read is incomplete, and review states map to events", () => {
  const facts = pullRequestFacts(
    answer({
      commits: {
        nodes: [{ commit: { statusCheckRollup: { contexts: { totalCount: 101, nodes: [] } } } }],
      },
    }),
  );
  expect(facts?.checksComplete).toBe(false);
  expect(pullRequestFacts(answer())?.checksComplete).toBe(true);
  expect(reviewEvent("APPROVED")).toBe("APPROVE");
  expect(reviewEvent("CHANGES_REQUESTED")).toBe("REQUEST_CHANGES");
  expect(reviewEvent("COMMENTED")).toBe("COMMENT");
});
