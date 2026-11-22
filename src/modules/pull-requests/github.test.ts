import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { GithubApi } from "../github-api/main.ts";
import {
  deleteRemoteBranch,
  mergePullRequest,
  observation,
  observeParent,
  observePullRequest,
  observeParkedPullRequests,
  openPullRequests,
  readMergeRequest,
  remoteBranch,
  retarget,
  markReady,
  postComment,
  updateComment,
  readMergeQueue,
  enqueuePullRequest,
} from "./github.ts";
import { mergeConditions } from "./wait-machine.ts";

test.each([undefined, null, { id: "Q7" }])(
  "parked membership must be explicitly observed: %j",
  async (entry) => {
    const data = answer({ mergeQueueEntry: entry });
    github(() => ok({ data: { viewer: data.viewer, r0: data.repository } }));
    const result = await observeParkedPullRequests([
      { repository: "owner/one", number: 7, parent: null },
    ]);
    if (entry === undefined)
      expect(result).toMatchObject({ tag: "Err", error: { reason: "github_invalid_response" } });
    else
      expect(result).toMatchObject({
        tag: "Ok",
        value: [{ observed: { queueEntry: entry === null ? null : "Q7" } }],
      });
  },
);

const readRecovery = {
  decider: "super-agent",
  question:
    "How should the failed or unconfirmed GitHub read be corrected before this workflow continues?",
};
const effectRecovery = {
  decider: "super-agent",
  question:
    "How should GitHub's current state be inspected before repeating the unconfirmed request?",
};

test("comment effects retain the inspect-before-repeat decision for every unconfirmed answer", async () => {
  for (const response of [
    { status: "failed", code: "http_422", detail: "Refused", httpStatus: 422 } as const,
    { status: "uncertain", detail: "Timed out." } as const,
  ]) {
    const call = github(() => response);
    call.mockClear();
    const expected = {
      tag: "Err",
      error: {
        reason: response.status === "failed" ? "github_failed" : "github_uncertain",
        detail: response.status === "failed" ? "http_422: Refused" : "Timed out.",
        next: effectRecovery,
      },
    };
    expect<unknown>(await postComment("owner/one", 7, "summary")).toEqual(expected);
    expect<unknown>(await updateComment("C1", "summary")).toEqual(expected);
    expect(call).toHaveBeenCalledTimes(2);
    expect(call.mock.calls[0]?.[0].input).toBe(JSON.stringify({ body: "summary" }));
    expect(call.mock.calls[1]?.[0].args).toContain("id=C1");
  }
});

function answer(change: Record<string, unknown> = {}) {
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
        isDraft: false,
        reviewDecision: null,
        mergeCommit: null,
        mergeQueueEntry: null,
        reviews: { nodes: [] },
        comments: { nodes: [] },
        reviewThreads: { totalCount: 0, nodes: [] },
        commits: {
          nodes: [{ commit: { statusCheckRollup: { contexts: { totalCount: 0, nodes: [] } } } }],
        },
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
        totalCount: 2,
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

test("threads and checks beyond one read keep the merge gate closed", () => {
  const passing = {
    __typename: "CheckRun" as const,
    name: "ok",
    status: "COMPLETED",
    conclusion: "SUCCESS",
    detailsUrl: null,
  };
  const observed = observation(
    answer({
      reviewThreads: {
        totalCount: 102,
        nodes: [{ isResolved: true, path: "a.ts", comments: { nodes: [] } }],
      },
      commits: {
        nodes: [
          { commit: { statusCheckRollup: { contexts: { totalCount: 2, nodes: [passing] } } } },
        ],
      },
    }),
  );
  // An unread thread can be unresolved, and an unread check can fail.
  expect(observed).toMatchObject({ unresolvedThreads: 101, checksComplete: false });
  expect(mergeConditions(observed, { stackRelayed: true, reviewEnded: true })).toMatchObject({
    threadsResolved: false,
    checksPassing: false,
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
                  totalCount: 12,
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

type Answer = Awaited<ReturnType<typeof GithubApi.call>>;

/** Answers every `gh api` call with `answer` and keeps each call's arguments. */
function github(answer: (args: string[]) => Answer | Promise<Answer>) {
  return spyOn(GithubApi, "call").mockImplementation(async (request) => answer(request.args));
}

function ok<B>(body: B): Answer {
  return { status: "succeeded", value: { httpStatus: 200, body } };
}

const refused: Answer = { status: "failed", code: "http_422", detail: "Refused", httpStatus: 422 };
const lost: Answer = { status: "uncertain", detail: "gh ended on SIGTERM" };

test("queue reads preserve base policy, membership, identity, state, and guarded head", async () => {
  const call = github(() =>
    ok({
      data: {
        repository: {
          pullRequest: {
            id: "PR7",
            state: "OPEN",
            headRefOid: "abc",
            isMergeQueueEnabled: true,
            mergeQueueEntry: { id: "Q7" },
          },
        },
      },
    }),
  );
  expect<unknown>(await readMergeQueue("owner/one", 7)).toMatchObject({
    tag: "Ok",
    value: { id: "PR7", state: "OPEN", head: "abc", enabled: true, entry: "Q7" },
  });
  expect(call.mock.calls[0]?.[0].args).toEqual([
    "graphql",
    "-f",
    expect.stringContaining("isMergeQueueEnabled mergeQueueEntry { id }"),
    "-f",
    "owner=owner",
    "-f",
    "name=one",
    "-F",
    "number=7",
  ]);
  call.mockImplementation(async () =>
    ok({
      data: {
        repository: {
          pullRequest: {
            id: "PR7",
            state: "OPEN",
            headRefOid: "abc",
            isMergeQueueEnabled: false,
            mergeQueueEntry: null,
          },
        },
      },
    }),
  );
  expect<unknown>(await readMergeQueue("owner/one", 7)).toMatchObject({
    tag: "Ok",
    value: { enabled: false, entry: null },
  });
});

test("queue policy reads fail closed rather than silently permitting a direct merge", async () => {
  for (const response of [refused, lost, ok({ data: { repository: { pullRequest: null } } })]) {
    github(() => response);
    expect((await readMergeQueue("owner/one", 7)).tag).toBe("Err");
  }
});

test("enqueue uses the guarded head without jumping the queue and validates GitHub's response", async () => {
  const call = github(() =>
    ok({ data: { enqueuePullRequest: { mergeQueueEntry: { id: "Q7" } } } }),
  );
  expect<unknown>(await enqueuePullRequest("PR7", "abc")).toMatchObject({ tag: "Ok" });
  const args = call.mock.calls[0]?.[0].args ?? [];
  expect<unknown>(args).toEqual([
    "graphql",
    "-f",
    expect.stringContaining("expectedHeadOid: $head"),
    "-f",
    "id=PR7",
    "-f",
    "head=abc",
  ]);
  expect(args.join(" ")).not.toContain("jump:");
  for (const [response, reason] of [
    [refused, "github_failed"],
    [lost, "github_uncertain"],
    [ok({ unknown: true }), "github_uncertain"],
    [ok({ data: null, errors: [{ message: "Restricted" }] }), "pr_enqueue_refused"],
    [
      ok({
        data: { enqueuePullRequest: { mergeQueueEntry: { id: "Q7" } } },
        errors: [{ message: "Partial failure" }],
      }),
      "pr_enqueue_refused",
    ],
  ] as const) {
    call.mockImplementation(async () => response);
    expect<unknown>(await enqueuePullRequest("PR7", "abc")).toMatchObject({
      tag: "Err",
      error: { reason },
    });
  }
});

test.each([
  [
    { enqueuePullRequest: null },
    [{ type: "UNPROCESSABLE", path: ["enqueuePullRequest"], message: "Restriction refused." }],
    true,
  ],
  [{ enqueuePullRequest: null }, [{ message: "Unknown outcome." }], false],
  [
    null,
    [{ type: "UNPROCESSABLE", path: ["enqueuePullRequest"], message: "Restriction refused." }],
    true,
  ],
  [null, [{ type: "FORBIDDEN", path: ["enqueuePullRequest"], message: "Not permitted." }], true],
  [null, [{ message: "Internal server error" }], false],
  [null, [{ type: "INTERNAL", path: ["enqueuePullRequest"], message: "Unknown outcome." }], false],
  [
    null,
    [
      {
        type: "UNPROCESSABLE",
        path: ["enqueuePullRequest", "mergeQueueEntry"],
        message: "Readback failure.",
      },
    ],
    false,
  ],
  [null, [], false],
  [
    { enqueuePullRequest: { mergeQueueEntry: { id: "Q7" } } },
    [{ type: "UNPROCESSABLE", path: ["enqueuePullRequest"], message: "Partial error." }],
    false,
  ],
] as const)(
  "enqueue nonapplication requires a typed mutation-level refusal: %j %j",
  async (data, errors, notApplied) => {
    github(() => ok({ data, errors }));
    expect(await enqueuePullRequest("PR7", "abc")).toMatchObject({
      tag: "Err",
      error: { reason: "pr_enqueue_refused", state: { notApplied } },
    });
  },
);

test("parked observation reads all PRs and recorded parents in one validated GitHub request", async () => {
  const parent = { state: "MERGED", baseRefName: "main", headRefOid: "parent-head" };
  const call = github(() =>
    ok({
      data: {
        viewer: { login: "owner" },
        r0: answer().repository,
        r1: {
          ...answer({ headRefOid: "child-head" }).repository,
          parent,
          parent1: { ...parent, headRefOid: "other-head", state: "OPEN" },
        },
      },
    }),
  );
  expect(
    await observeParkedPullRequests([
      { repository: "owner/one", number: 7, parent: null },
      { repository: "owner/two", number: 8, parent: 6, parents: [6, 9] },
    ]),
  ).toMatchObject({
    tag: "Ok",
    value: [
      { observed: { head: "abc" }, parent: null },
      {
        observed: { head: "child-head" },
        parent: { state: "MERGED", head: "parent-head", base: "main" },
        parents: [
          { number: 6, state: "MERGED" },
          { number: 9, state: "OPEN", head: "other-head" },
        ],
      },
    ],
  });
  expect(call).toHaveBeenCalledTimes(1);
  const query = call.mock.calls[0]?.[0].args.find((arg) => arg.startsWith("query="));
  expect(query).toContain('r0: repository(owner: "owner", name: "one")');
  expect(query).toContain('r1: repository(owner: "owner", name: "two")');
  expect(query).toContain("parent: pullRequest(number: 6)");
  expect(query).toContain("parent1: pullRequest(number: 9)");
});

test("a partial parked batch or missing recorded parent refuses without another GitHub read", async () => {
  for (const body of [
    { data: { viewer: { login: "owner" } } },
    { data: { viewer: { login: "owner" }, r0: answer().repository } },
  ]) {
    const call = github(() => ok(body));
    call.mockClear();
    expect(
      await observeParkedPullRequests([{ repository: "owner/one", number: 7, parent: 6 }]),
    ).toMatchObject({ tag: "Err", error: { reason: "github_invalid_response" } });
    expect(call).toHaveBeenCalledTimes(1);
  }
});

test("parked feedback pages stay batched and include older feedback beyond the first hundred", async () => {
  let reads = 0;
  const call = github((args) => {
    reads++;
    if (reads === 2) expect(args.join(" ")).toContain('after: "older"');
    const comments = {
      nodes:
        reads === 1
          ? Array.from({ length: 100 }, (_, index) => ({
              id: `C${index}`,
              body: "first page",
              url: "u",
              author: null,
            }))
          : [
              {
                id: "older",
                body: "Edited old feedback",
                updatedAt: "now",
                url: "u",
                author: null,
              },
            ],
      pageInfo: { hasNextPage: reads === 1, endCursor: reads === 1 ? "older" : "end" },
    };
    return ok({
      data: {
        viewer: { login: "owner" },
        r0: answer({ comments }).repository,
        r1: answer({ comments }).repository,
      },
    });
  });
  const result = await observeParkedPullRequests([
    { repository: "owner/one", number: 7, parent: null },
    { repository: "owner/two", number: 8, parent: null },
  ]);
  expect(result.tag).toBe("Ok");
  if (result.tag !== "Ok") return;
  expect(result.value.map(({ observed }) => observed.feedback.length)).toEqual([101, 101]);
  expect(result.value[0]?.observed.feedback.at(-1)).toMatchObject({
    id: "older",
    body: "Edited old feedback",
  });
  expect(call).toHaveBeenCalledTimes(2);
});

test("a batch with a hundred completed checks and an unread pending context fails closed", async () => {
  const passing = {
    __typename: "CheckRun",
    name: "completed",
    status: "COMPLETED",
    conclusion: "SUCCESS",
    detailsUrl: null,
  };
  const data = answer({
    commits: {
      nodes: [
        {
          commit: {
            statusCheckRollup: {
              contexts: { totalCount: 101, nodes: Array.from({ length: 100 }, () => passing) },
            },
          },
        },
      ],
    },
  });
  const call = github(() => ok({ data: { viewer: { login: "owner" }, r0: data.repository } }));
  const result = await observeParkedPullRequests([
    { repository: "owner/one", number: 7, parent: null },
  ]);
  expect(result).toMatchObject({
    tag: "Err",
    error: { reason: "github_invalid_response" },
  });
  if (result.tag === "Err") expect(result.error.detail).toContain("check");
  expect(call).toHaveBeenCalledTimes(1);
});

test.each(["null", "missing", "incomplete"] as const)(
  "a parked %s check observation is not acknowledged as a complete empty set",
  async (kind) => {
    const commits = {
      nodes:
        kind === "missing"
          ? []
          : [
              {
                commit: {
                  statusCheckRollup:
                    kind === "null" ? null : { contexts: { totalCount: 1, nodes: [] } },
                },
              },
            ],
    };
    const data = answer({ commits });
    expect(observation(data).checksComplete).toBe(false);
    github(() => ok({ data: { viewer: data.viewer, r0: data.repository } }));
    expect(
      await observeParkedPullRequests([{ repository: "owner/one", number: 7, parent: null }]),
    ).toMatchObject({ tag: "Err", error: { reason: "github_invalid_response" } });
  },
);

test("a checked complete empty context connection remains a valid observation", async () => {
  github(() => ok({ data: { viewer: answer().viewer, r0: answer().repository } }));
  expect(
    await observeParkedPullRequests([{ repository: "owner/one", number: 7, parent: null }]),
  ).toMatchObject({ tag: "Ok", value: [{ observed: { checksComplete: true, checks: [] } }] });
});

test.each(["live", "batch", "page", "thread"] as const)(
  "a %s GraphQL error rejects usable-looking partial data",
  async (kind) => {
    let reads = 0;
    github(() => {
      reads++;
      const paged = kind === "page" || kind === "thread";
      const comments = {
        nodes: [{ id: `C${reads}`, body: "claim", url: "u", author: null }],
        pageInfo: { hasNextPage: reads === 1, endCursor: String(reads) },
      };
      const data = answer(
        kind === "page"
          ? { comments }
          : kind === "thread"
            ? {
                reviewThreads: {
                  totalCount: 1,
                  nodes: [{ id: "T", isResolved: false, path: "a.ts", comments }],
                },
              }
            : {},
      );
      return ok({
        data:
          kind === "live"
            ? data
            : kind === "thread" && reads > 1
              ? { t0: { pullRequest: { headRefOid: "abc" }, comments } }
              : { viewer: data.viewer, r0: data.repository },
        errors: !paged || reads > 1 ? [{ message: "Partial read refused" }] : [],
      });
    });
    expect(
      await (kind === "live"
        ? observePullRequest("owner/one", 7)
        : observeParkedPullRequests([{ repository: "owner/one", number: 7, parent: null }])),
    ).toMatchObject({ tag: "Err", error: { reason: "github_invalid_response" } });
    expect(reads).toBe(kind === "page" || kind === "thread" ? 2 : 1);
  },
);

test("an unknown completed check conclusion remains pending rather than granting quiet parking", () => {
  const data = answer({
    commits: {
      nodes: [
        {
          commit: {
            statusCheckRollup: {
              contexts: {
                totalCount: 1,
                nodes: [
                  {
                    __typename: "CheckRun",
                    name: "unknown",
                    status: "COMPLETED",
                    conclusion: "FUTURE_UNKNOWN",
                    detailsUrl: null,
                  },
                ],
              },
            },
          },
        },
      ],
    },
  });
  expect(observation(data).checks).toEqual([{ name: "unknown", state: "pending", url: null }]);
});

test("thread-comment continuation includes feedback older than the first thread page", async () => {
  let reads = 0;
  const call = github((args) => {
    reads++;
    if (reads === 2) {
      expect(args.join(" ")).toContain('node(id: "thread")');
      return ok({
        data: {
          t0: {
            pullRequest: { headRefOid: "abc" },
            comments: {
              pageInfo: { hasNextPage: false, endCursor: "end" },
              nodes: [
                {
                  id: "older-inline",
                  body: "old inline edit",
                  updatedAt: "v2",
                  url: "u",
                  author: null,
                },
              ],
            },
          },
        },
      });
    }
    const reviewThreads = {
      totalCount: 1,
      pageInfo: { hasNextPage: false, endCursor: "end" },
      nodes: [
        {
          id: "thread",
          isResolved: false,
          path: "file.ts",
          comments: { pageInfo: { hasNextPage: true, endCursor: "older" }, nodes: [] },
        },
      ],
    };
    return ok({ data: { viewer: { login: "owner" }, r0: answer({ reviewThreads }).repository } });
  });
  const result = await observeParkedPullRequests([
    { repository: "owner/one", number: 7, parent: null },
  ]);
  expect(result.tag).toBe("Ok");
  if (result.tag === "Ok")
    expect(result.value[0]?.observed.feedback).toMatchObject([
      { id: "older-inline", body: "old inline edit", kind: "thread_comment" },
    ]);
  expect(call).toHaveBeenCalledTimes(2);
});

test.each(["head", "cursor", "error"] as const)(
  "a paged feedback %s failure refuses the whole observation",
  async (failure) => {
    let reads = 0;
    const call = github(() => {
      reads++;
      if (reads > 1 && failure === "error") return refused;
      const comments = { nodes: [], pageInfo: { hasNextPage: true, endCursor: "repeated" } };
      return ok({
        data: {
          viewer: { login: "owner" },
          r0: answer({
            comments,
            headRefOid: reads > 1 && failure === "head" ? "different" : "abc",
          }).repository,
        },
      });
    });
    expect(
      await observeParkedPullRequests([{ repository: "owner/one", number: 7, parent: null }]),
    ).toMatchObject({ tag: "Err" });
    expect(call).toHaveBeenCalledTimes(2);
  },
);
test.each(["comments", "thread", "cycle-comments", "cycle-thread"] as const)(
  "a repeated terminal %s cursor refuses instead of returning duplicate feedback",
  async (connection) => {
    let reads = 0;
    const nested = connection.endsWith("thread");
    const cycle = connection.startsWith("cycle");
    github(() => {
      reads++;
      const terminal = reads === (cycle ? 3 : 2);
      const comments = {
        nodes: [{ id: "same", body: "claim", url: "u", author: null }],
        pageInfo: { hasNextPage: !terminal, endCursor: reads === 2 && cycle ? "second" : "first" },
      };
      if (nested && reads > 1)
        return ok({ data: { t0: { pullRequest: { headRefOid: "abc" }, comments } } });
      return ok({
        data: {
          viewer: answer().viewer,
          r0: answer(
            nested
              ? {
                  reviewThreads: {
                    totalCount: 1,
                    nodes: [{ id: "thread", isResolved: false, path: "file.ts", comments }],
                  },
                }
              : { comments },
          ).repository,
        },
      });
    });
    expect(
      await observeParkedPullRequests([{ repository: "owner/one", number: 7, parent: null }]),
    ).toMatchObject({ tag: "Err", error: { reason: "github_invalid_response" } });
    expect(reads).toBe(cycle ? 3 : 2);
  },
);

afterEach(() => {
  mock.restore();
});

test("a ready transition failure retains observed uncertainty and requires inspection before another request", async () => {
  for (const [answer, error] of [
    [
      refused,
      { reason: "github_failed", detail: "http_422: Refused", state: { code: "http_422" } },
    ],
    [
      lost,
      {
        reason: "github_uncertain",
        detail: "gh ended on SIGTERM",
        state: { requestStatus: "uncertain" },
      },
    ],
    [
      ok({}),
      {
        reason: "github_uncertain",
        detail: "GitHub answered the ready mutation in an unknown form.",
        state: { responseValid: false },
      },
    ],
    [
      ok({ data: { markPullRequestReadyForReview: { pullRequest: { isDraft: true } } } }),
      {
        reason: "github_failed",
        detail: "The PR stayed a draft.",
        state: { readyConfirmed: false },
      },
    ],
    [
      ok({ data: null, errors: [{ message: "denied" }] }),
      { reason: "github_failed", detail: "denied", state: { readyConfirmed: false } },
    ],
  ] as const) {
    const call = github(() => answer);
    call.mockClear();
    expect<unknown>(await markReady("PR_node")).toEqual({
      tag: "Err",
      error: { ...error, next: effectRecovery },
    });
    expect(call).toHaveBeenCalledTimes(1);
    expect(call.mock.calls[0]?.[0].args[0]).toBe("graphql");
    expect(call.mock.calls[0]?.[0].args.slice(-2)).toEqual(["-f", "id=PR_node"]);
    expect(call.mock.calls[0]?.[0].timeoutMs).toBe(60000);
  }
});

describe("GitHub reads and effects", () => {
  afterEach(() => {
    mock.restore();
  });

  test("open PRs are read for the branch and keep only the project's own heads", async () => {
    const call = github(() =>
      ok({
        data: {
          repository: {
            defaultBranchRef: { name: "main" },
            pullRequests: {
              nodes: [
                ["task/1", "Owner/One", 7],
                ["task/1", "fork/one", 8],
                ["task/2", "owner/one", 9],
                ["task/1", null, 10],
              ].map(([head, owner, number]) => ({
                number,
                url: `u${number}`,
                isDraft: number === 7,
                baseRefName: "main",
                headRefName: head,
                headRefOid: `h${number}`,
                headRepository: owner === null ? null : { nameWithOwner: owner },
              })),
            },
          },
        },
      }),
    );
    expect<unknown>(await openPullRequests("owner/one", "task/1")).toEqual({
      tag: "Ok",
      value: [
        { number: 7, url: "u7", base: "main", defaultBranch: "main", draft: true, head: "h7" },
      ],
    });
    const args = call.mock.calls[0]?.[0].args ?? [];
    expect(args.slice(0, 2)).toEqual(["graphql", "-f"]);
    expect(args[2]).toStartWith("query=query($owner: String!, $name: String!, $branch: String!)");
    expect(args.slice(3)).toEqual(["-f", "owner=owner", "-f", "name=one", "-f", "branch=task/1"]);
    expect(call.mock.calls[0]?.[0].timeoutMs).toBe(60000);
  });

  test("a repository without a default branch reports none", async () => {
    github(() =>
      ok({
        data: {
          repository: {
            defaultBranchRef: null,
            pullRequests: {
              nodes: [
                {
                  number: 7,
                  url: "u7",
                  isDraft: false,
                  baseRefName: "dev",
                  headRefName: "task/1",
                  headRefOid: "h7",
                  headRepository: { nameWithOwner: "owner/one" },
                },
              ],
            },
          },
        },
      }),
    );
    expect<unknown>(await openPullRequests("owner/one", "task/1")).toEqual({
      tag: "Ok",
      value: [{ number: 7, url: "u7", base: "dev", defaultBranch: null, draft: false, head: "h7" }],
    });
  });

  test("a failed, lost, or unexpected read answer is a read failure", async () => {
    for (const [answer, error] of [
      [
        refused,
        {
          reason: "github_failed",
          detail: "http_422: Refused",
          next: readRecovery,
          state: { code: "http_422" },
        },
      ],
      [
        lost,
        {
          reason: "github_uncertain",
          detail: "gh ended on SIGTERM",
          next: readRecovery,
          state: { requestStatus: "uncertain" },
        },
      ],
      [
        ok({ data: {} }),
        {
          reason: "github_invalid_response",
          next: readRecovery,
          state: { responseValid: false },
          detail: "GitHub did not describe the pull request in the expected form.",
        },
      ],
    ] as const) {
      github(() => answer);
      expect<unknown>(await observeParent("owner/one", 6)).toEqual({ tag: "Err", error });
    }
    github(() => Promise.reject(new Error("boom")));
    expect<unknown>(await observeParent("owner/one", 6)).toMatchObject({ tag: "Defect" });
  });

  test("the stack parent is read by number", async () => {
    const call = github(() =>
      ok({
        data: {
          repository: { pullRequest: { state: "MERGED", baseRefName: "main", headRefOid: "p1" } },
        },
      }),
    );
    expect<unknown>(await observeParent("owner/one", 6)).toEqual({
      tag: "Ok",
      value: { state: "MERGED", base: "main", head: "p1" },
    });
    const args = call.mock.calls[0]?.[0].args ?? [];
    expect(args.slice(0, 2)).toEqual(["graphql", "-f"]);
    expect(args[2]).toStartWith("query=query RelayParent(");
    expect(args.slice(3)).toEqual(["-f", "owner=owner", "-f", "name=one", "-F", "number=6"]);
  });

  test("a PR observation is read by number", async () => {
    const call = github(() => ok({ data: answer({ state: "CLOSED" }) }));
    expect<unknown>(await observePullRequest("owner/one", 7)).toMatchObject({
      tag: "Ok",
      value: { state: "CLOSED", head: "abc", mergeMethod: "squash" },
    });
    const args = call.mock.calls[0]?.[0].args ?? [];
    expect(args.slice(0, 2)).toEqual(["graphql", "-f"]);
    expect(args[2]).toStartWith("query=query($owner: String!, $name: String!, $number: Int!)");
    expect(args.slice(3)).toEqual(["-f", "owner=owner", "-f", "name=one", "-F", "number=7"]);
  });

  test("a retarget changes the base and reports any failure as text", async () => {
    const call = github(() => ok({}));
    expect<unknown>(await retarget("owner/one", 7, "main")).toEqual({ tag: "Ok", value: null });
    expect(call.mock.calls[0]?.[0]).toEqual({
      args: ["-X", "PATCH", "repos/owner/one/pulls/7", "-f", "base=main"],
      timeoutMs: 60000,
    });
    github(() => refused);
    expect<unknown>(await retarget("owner/one", 7, "main")).toEqual({
      tag: "Ok",
      value: "http_422: Refused",
    });
    github(() => lost);
    expect<unknown>(await retarget("owner/one", 7, "main")).toEqual({
      tag: "Ok",
      value: "GitHub did not answer, so the base change is unknown: gh ended on SIGTERM",
    });
    github(() => Promise.reject(new Error("boom")));
    expect<unknown>(await retarget("owner/one", 7, "main")).toMatchObject({ tag: "Defect" });
  });

  test("a background merge request names the guarded head, method, and a direct merge", async () => {
    const pending = {
      status: "pending",
      details: { message: "Merge request enqueued.", uuid: "u1" },
    };
    const call = github(() => ({ status: "succeeded", value: { httpStatus: 202, body: pending } }));
    expect<unknown>(
      await mergePullRequest("owner/one", { number: 7, head: "h1", method: "rebase" }),
    ).toEqual({
      tag: "Ok",
      value: { status: "pending", uuid: "u1", message: "Merge request enqueued." },
    });
    expect(call.mock.calls[0]?.[0]).toEqual({
      args: [
        "-X",
        "PUT",
        "repos/owner/one/pulls/7/merge-async",
        "-f",
        "sha=h1",
        "-f",
        "merge_method=rebase",
        "-f",
        "merge_action=direct_merge",
      ],
      timeoutMs: 60000,
    });
    github(() => refused);
    expect<unknown>(
      await mergePullRequest("owner/one", { number: 7, head: "h1", method: "merge" }),
    ).toEqual({
      tag: "Err",
      error: { reason: "github_failed", detail: "http_422: Refused", next: effectRecovery },
    });
    github(() => lost);
    expect<unknown>(
      await mergePullRequest("owner/one", { number: 7, head: "h1", method: "merge" }),
    ).toEqual({
      tag: "Err",
      error: { reason: "github_uncertain", detail: "gh ended on SIGTERM", next: effectRecovery },
    });
    github(() => Promise.reject(new Error("boom")));
    expect<unknown>(
      await mergePullRequest("owner/one", { number: 7, head: "h1", method: "merge" }),
    ).toMatchObject({ tag: "Defect" });
  });

  test("a merge request's state is read by its id, and an unreadable state stays uncertain", async () => {
    const call = github(() =>
      ok({ status: "merged", details: { message: "Pull request was merged.", sha: "m1" } }),
    );
    expect<unknown>(await readMergeRequest("owner/one", 7, "u1")).toEqual({
      tag: "Ok",
      value: { status: "merged", uuid: null, message: "Pull request was merged." },
    });
    expect(call.mock.calls[0]?.[0]).toEqual({
      args: ["repos/owner/one/pulls/7/merge-async/u1"],
      timeoutMs: 60000,
    });
    for (const status of ["pending", "enqueued", "failed"] as const) {
      github(() => ok({ status, details: { message: "m" } }));
      expect<unknown>(await readMergeRequest("owner/one", 7, "u1")).toEqual({
        tag: "Ok",
        value: { status, uuid: null, message: "m" },
      });
    }
    for (const body of [{ merged: true }, { status: "done", details: { message: "m" } }, null]) {
      github(() => ok(body));
      expect<unknown>(await readMergeRequest("owner/one", 7, "u1")).toEqual({
        tag: "Err",
        error: {
          reason: "github_uncertain",
          detail: "GitHub did not describe the merge request in the expected form.",
          next: effectRecovery,
        },
      });
    }
    github(() => Promise.reject(new Error("boom")));
    expect<unknown>(await readMergeRequest("owner/one", 7, "u1")).toMatchObject({
      tag: "Defect",
    });
    // A 409 names a request that already runs, so the merge stays pending without its id.
    github(() => ({
      status: "failed",
      code: "http_409",
      detail: "A merge request already exists for this pull request.",
      httpStatus: 409,
    }));
    expect<unknown>(
      await mergePullRequest("owner/one", { number: 7, head: "h1", method: "squash" }),
    ).toEqual({
      tag: "Ok",
      value: {
        status: "pending",
        uuid: null,
        message: "GitHub already runs a merge request for this PR.",
      },
    });
  });

  test("a remote branch reads as its commit, or null when GitHub has no such branch", async () => {
    const call = github(() => ok({ object: { sha: "c1" } }));
    expect<unknown>(await remoteBranch("owner/one", "task/1")).toEqual({ tag: "Ok", value: "c1" });
    expect(call.mock.calls[0]?.[0]).toEqual({
      args: ["repos/owner/one/git/ref/heads/task/1"],
      timeoutMs: 60000,
    });
    github(() => ({ status: "failed", code: "http_404", detail: "Not Found", httpStatus: 404 }));
    expect<unknown>(await remoteBranch("owner/one", "task/1")).toEqual({ tag: "Ok", value: null });
    github(() => refused);
    expect<unknown>(await remoteBranch("owner/one", "task/1")).toEqual({
      tag: "Err",
      error: {
        reason: "github_failed",
        detail: "http_422: Refused",
        next: readRecovery,
        state: { code: "http_422" },
      },
    });
    github(() => lost);
    expect<unknown>(await remoteBranch("owner/one", "task/1")).toEqual({
      tag: "Err",
      error: {
        reason: "github_uncertain",
        detail: "gh ended on SIGTERM",
        next: readRecovery,
        state: { requestStatus: "uncertain" },
      },
    });
    github(() => ok({ object: {} }));
    expect<unknown>(await remoteBranch("owner/one", "task/1")).toEqual({
      tag: "Err",
      error: {
        reason: "github_invalid_response",
        detail: "GitHub did not describe the branch task/1 in the expected form.",
        next: readRecovery,
        state: { responseValid: false },
      },
    });
    github(() => Promise.reject(new Error("boom")));
    expect<unknown>(await remoteBranch("owner/one", "task/1")).toMatchObject({ tag: "Defect" });
  });

  test("a branch deletion reports any failure as text", async () => {
    const call = github(() => ({ status: "succeeded", value: { httpStatus: 204, body: null } }));
    expect<unknown>(await deleteRemoteBranch("owner/one", "task/1")).toEqual({
      tag: "Ok",
      value: null,
    });
    expect(call.mock.calls[0]?.[0]).toEqual({
      args: ["-X", "DELETE", "repos/owner/one/git/refs/heads/task/1"],
      timeoutMs: 60000,
    });
    github(() => refused);
    expect<unknown>(await deleteRemoteBranch("owner/one", "task/1")).toEqual({
      tag: "Ok",
      value: "http_422: Refused",
    });
    github(() => lost);
    expect<unknown>(await deleteRemoteBranch("owner/one", "task/1")).toEqual({
      tag: "Ok",
      value: "gh ended on SIGTERM",
    });
    github(() => Promise.reject(new Error("boom")));
    expect<unknown>(await deleteRemoteBranch("owner/one", "task/1")).toMatchObject({
      tag: "Defect",
    });
  });
});

test("the viewer's default merge method maps to the REST merge method", () => {
  for (const [method, expected] of [
    ["MERGE", "merge"],
    ["SQUASH", "squash"],
    ["REBASE", "rebase"],
  ] as const) {
    const data = answer();
    expect(
      observation({ ...data, repository: { ...data.repository, viewerDefaultMergeMethod: method } })
        .mergeMethod,
    ).toBe(expected);
  }
});

test("a merge commit and an unanswered review decision are kept", () => {
  expect(observation(answer({ mergeCommit: { oid: "m1" } }))).toMatchObject({
    mergeCommit: "m1",
    approved: false,
  });
  expect(observation(answer({ reviewDecision: "CHANGES_REQUESTED" })).approved).toBe(false);
  expect(observation(answer()).mergeCommit).toBeNull();
});

test("a draft PR is observed as a draft", () => {
  expect(observation(answer()).draft).toBe(false);
  expect(observation(answer({ isDraft: true })).draft).toBe(true);
});

describe("GitHub answers in the expected form", () => {
  afterEach(() => {
    mock.restore();
  });

  test("a full PR answer maps every field the wait reads", async () => {
    const node = { id: "C", body: "Fix.", url: "u", author: { login: "owner" } };
    github(() =>
      ok({
        data: answer({
          state: "MERGED",
          isDraft: true,
          mergeCommit: { oid: "m1" },
          reviewDecision: "APPROVED",
          reviews: { nodes: [{ ...node, id: "R", state: "APPROVED" }] },
          comments: { nodes: [node] },
          reviewThreads: {
            totalCount: 3,
            nodes: [
              { isResolved: false, path: "a.ts", comments: { nodes: [{ ...node, id: "T" }] } },
              { isResolved: false, path: "b.ts", comments: { nodes: [] } },
              { isResolved: true, path: "c.ts", comments: { nodes: [] } },
            ],
          },
          commits: {
            nodes: [
              {
                commit: {
                  statusCheckRollup: {
                    contexts: {
                      totalCount: 2,
                      nodes: [
                        {
                          __typename: "CheckRun",
                          name: "run",
                          status: "COMPLETED",
                          conclusion: "SUCCESS",
                          detailsUrl: "d",
                        },
                        {
                          __typename: "StatusContext",
                          context: "status",
                          state: "PENDING",
                          targetUrl: "t",
                        },
                      ],
                    },
                  },
                },
              },
            ],
          },
        }),
      }),
    );
    const feedback = {
      author: "owner",
      fromViewer: true,
      operatorReview: false,
      body: "Fix.",
      url: "u",
    };
    expect<unknown>(await observePullRequest("owner/one", 7)).toEqual({
      tag: "Ok",
      value: {
        state: "MERGED",
        head: "abc",
        mergeCommit: "m1",
        queueEntry: null,
        mergeMethod: "squash",
        base: "main",
        defaultBranch: "main",
        draft: true,
        approved: true,
        unresolvedThreads: 2,
        checksComplete: true,
        feedback: [
          {
            ...feedback,
            id: "R",
            kind: "review",
            reviewState: "APPROVED",
            path: null,
            threadResolved: null,
          },
          {
            ...feedback,
            id: "C",
            kind: "comment",
            reviewState: null,
            path: null,
            threadResolved: null,
          },
          {
            ...feedback,
            id: "T",
            kind: "thread_comment",
            reviewState: null,
            path: "a.ts",
            threadResolved: false,
          },
        ],
        checks: [
          { name: "run", state: "passing", url: "d" },
          { name: "status", state: "pending", url: "t" },
        ],
      },
    });
  });

  test("every state and merge method that GitHub names is read", async () => {
    for (const state of ["OPEN", "MERGED", "CLOSED"] as const)
      for (const method of ["MERGE", "SQUASH", "REBASE"] as const) {
        const data = answer({ state });
        github(() =>
          ok({
            data: { ...data, repository: { ...data.repository, viewerDefaultMergeMethod: method } },
          }),
        );
        expect<unknown>(await observePullRequest("owner/one", 7)).toMatchObject({
          tag: "Ok",
          value: { state, mergeMethod: method.toLowerCase() },
        });
      }
    for (const state of ["OPEN", "MERGED", "CLOSED"] as const) {
      github(() =>
        ok({
          data: { repository: { pullRequest: { state, baseRefName: "main", headRefOid: "p1" } } },
        }),
      );
      expect<unknown>(await observeParent("owner/one", 6)).toMatchObject({
        tag: "Ok",
        value: { state },
      });
    }
  });

  test("a PR answer with a missing field is not in the expected form", async () => {
    const invalid = {
      tag: "Err",
      error: {
        reason: "github_invalid_response",
        next: readRecovery,
        state: { responseValid: false },
        detail: "GitHub did not describe the pull request in the expected form.",
      },
    };
    const node = { id: "C", body: "b", url: "u", author: { login: "x" } };
    function check(context: Record<string, unknown>) {
      return { nodes: [{ commit: { statusCheckRollup: { contexts: { nodes: [context] } } } }] };
    }

    const changes: Record<string, unknown>[] = [
      { comments: { nodes: [{ ...node, author: {} }] } },
      { comments: { nodes: [{ ...node, body: undefined }] } },
      { mergeCommit: {} },
      { reviews: { nodes: [node] } },
      { reviewThreads: { nodes: [] } },
      { commits: { nodes: [{ commit: { statusCheckRollup: { contexts: { nodes: [] } } } }] } },
      { reviewThreads: { nodes: [{ isResolved: false, comments: { nodes: [] } }] } },
      {
        reviewThreads: {
          nodes: [{ isResolved: false, path: "a", comments: { nodes: [{ id: "x" }] } }],
        },
      },
      { commits: { nodes: [{ commit: {} }] } },
      { commits: { nodes: [{ commit: { statusCheckRollup: {} } }] } },
      { commits: { nodes: [{ commit: { statusCheckRollup: { contexts: {} } } }] } },
      { commits: check({ __typename: "CheckRun", name: "r", status: "QUEUED", conclusion: null }) },
      { commits: check({ __typename: "StatusContext", context: "s", targetUrl: null }) },
      { commits: check({ __typename: "Other", context: "s", state: "SUCCESS", targetUrl: null }) },
    ];
    for (const change of changes) {
      github(() => ok({ data: answer(change) }));
      expect<unknown>(await observePullRequest("owner/one", 7)).toEqual(invalid);
    }
    const data = answer();
    for (const repository of [
      { ...data.repository, defaultBranchRef: {} },
      { ...data.repository, viewerDefaultMergeMethod: "FAST_FORWARD" },
    ]) {
      github(() => ok({ data: { ...data, repository } }));
      expect<unknown>(await observePullRequest("owner/one", 7)).toEqual(invalid);
    }
    github(() => ok({ data: { ...data, viewer: {} } }));
    expect<unknown>(await observePullRequest("owner/one", 7)).toEqual(invalid);
  });

  test("a repository name without an owner part sends empty fields", async () => {
    const call = github(() => refused);
    await openPullRequests("solo", "task/1");
    expect(call.mock.calls[0]?.[0].args.slice(3, 7)).toEqual(["-f", "owner=solo", "-f", "name="]);
    await openPullRequests("", "task/1");
    expect(call.mock.calls[1]?.[0].args.slice(3, 7)).toEqual(["-f", "owner=", "-f", "name="]);
  });
});

test("an unfinished check run or one without a conclusion is pending", () => {
  function rollup(status: string, conclusion: string | null) {
    return {
      commits: {
        nodes: [
          {
            commit: {
              statusCheckRollup: {
                contexts: {
                  totalCount: 1,
                  nodes: [
                    {
                      __typename: "CheckRun" as const,
                      name: "r",
                      status,
                      conclusion,
                      detailsUrl: null,
                    },
                  ],
                },
              },
            },
          },
        ],
      },
    };
  }

  expect(observation(answer(rollup("IN_PROGRESS", "FAILURE"))).checks[0]?.state).toBe("pending");
  expect(observation(answer(rollup("COMPLETED", null))).checks[0]?.state).toBe("pending");
  expect(observation(answer(rollup("COMPLETED", "FAILURE"))).checks[0]?.state).toBe("failing");
});
