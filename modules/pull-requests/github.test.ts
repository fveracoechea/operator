import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { GithubApi } from "../github-api/main.ts";
import {
  deleteRemoteBranch,
  mergePullRequest,
  observation,
  observeParent,
  observePullRequest,
  openPullRequests,
  remoteBranch,
  retarget,
} from "./github.ts";

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
                baseRefName: "main",
                headRefName: head,
                headRepository: owner === null ? null : { nameWithOwner: owner },
              })),
            },
          },
        },
      }),
    );
    expect<unknown>(await openPullRequests("owner/one", "task/1")).toEqual({
      tag: "Ok",
      value: [{ number: 7, url: "u7", base: "main", defaultBranch: "main" }],
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
                  baseRefName: "dev",
                  headRefName: "task/1",
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
      value: [{ number: 7, url: "u7", base: "dev", defaultBranch: null }],
    });
  });

  test("a failed, lost, or unexpected read answer is a read failure", async () => {
    for (const [answer, error] of [
      [refused, { reason: "github_failed", detail: "http_422: Refused" }],
      [lost, { reason: "github_uncertain", detail: "gh ended on SIGTERM" }],
      [
        ok({ data: {} }),
        {
          reason: "github_invalid_response",
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

  test("a merge request names the guarded head and method", async () => {
    const call = github(() => ok({ merged: true }));
    expect<unknown>(
      await mergePullRequest("owner/one", { number: 7, head: "h1", method: "rebase" }),
    ).toEqual({ tag: "Ok", value: undefined });
    expect(call.mock.calls[0]?.[0]).toEqual({
      args: [
        "-X",
        "PUT",
        "repos/owner/one/pulls/7/merge",
        "-f",
        "sha=h1",
        "-f",
        "merge_method=rebase",
      ],
      timeoutMs: 60000,
    });
    github(() => refused);
    expect<unknown>(
      await mergePullRequest("owner/one", { number: 7, head: "h1", method: "merge" }),
    ).toEqual({ tag: "Err", error: { reason: "github_failed", detail: "http_422: Refused" } });
    github(() => lost);
    expect<unknown>(
      await mergePullRequest("owner/one", { number: 7, head: "h1", method: "merge" }),
    ).toEqual({ tag: "Err", error: { reason: "github_uncertain", detail: "gh ended on SIGTERM" } });
    github(() => Promise.reject(new Error("boom")));
    expect<unknown>(
      await mergePullRequest("owner/one", { number: 7, head: "h1", method: "merge" }),
    ).toMatchObject({ tag: "Defect" });
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
      error: { reason: "github_failed", detail: "http_422: Refused" },
    });
    github(() => lost);
    expect<unknown>(await remoteBranch("owner/one", "task/1")).toEqual({
      tag: "Err",
      error: { reason: "github_uncertain", detail: "gh ended on SIGTERM" },
    });
    github(() => ok({ object: {} }));
    expect<unknown>(await remoteBranch("owner/one", "task/1")).toEqual({
      tag: "Err",
      error: {
        reason: "github_invalid_response",
        detail: "GitHub did not describe the branch task/1 in the expected form.",
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
          mergeCommit: { oid: "m1" },
          reviewDecision: "APPROVED",
          reviews: { nodes: [{ ...node, id: "R", state: "APPROVED" }] },
          comments: { nodes: [node] },
          reviewThreads: {
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
        mergeMethod: "squash",
        base: "main",
        defaultBranch: "main",
        approved: true,
        unresolvedThreads: 2,
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
