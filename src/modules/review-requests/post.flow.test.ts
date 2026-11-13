import { afterEach, beforeEach, expect, mock, setSystemTime, spyOn, test } from "bun:test";
// Bun has no permission API.
import { chmod } from "node:fs/promises";
import { Ok, OkAsync } from "unthrown";
import { z } from "zod";
import { DeviceState } from "../device-state/main.ts";
import { GithubApi } from "../github-api/main.ts";
import { Herdr } from "../herdr/main.ts";
import { WorkerDispatch } from "../worker-dispatch/main.ts";
import {
  answered,
  h1,
  h2,
  prAnswer,
  readRequest,
  reviewHome,
  seedRequest,
  target,
  url,
} from "./home-fixture.ts";
import { post } from "./post.ts";
import { files, type Row } from "./request.ts";

// Root ignores file modes, so a test of a denied access cannot run as root.
const asRoot = process.getuid?.() === 0;

type Home = Awaited<ReturnType<typeof reviewHome>>;
type Outcome = Awaited<ReturnType<typeof GithubApi.call>>;
let home: Home;
const now = "2026-02-03T04:05:06.000Z";
const marker = "<!-- operator-review r1 round 1 -->";

beforeEach(async () => {
  home = await reviewHome();
  setSystemTime(new Date(now));
});

afterEach(async () => {
  setSystemTime();
  mock.restore();
  await home.remove();
});

const payloadSchema = z.looseObject({
  commit_id: z.string(),
  event: z.string(),
  body: z.string(),
  comments: z
    .array(z.object({ path: z.string(), line: z.number(), body: z.string(), side: z.string() }))
    .optional(),
});

type Handlers = {
  read?: () => Outcome;
  post?: () => Outcome;
  reply?: (thread: string) => Outcome | Promise<Outcome>;
  unresolve?: (thread: string) => Outcome;
};

/** Routes each `gh api` call to its handler and records the review posts and thread writes. */
function github(handlers: Handlers) {
  const posts: z.infer<typeof payloadSchema>[] = [];
  const writes: string[] = [];
  const reads: number[] = [];
  spyOn(GithubApi, "call").mockImplementation(async (request) => {
    function field(name: string) {
      return request.args.find((arg) => arg.startsWith(`${name}=`))?.slice(name.length + 1) ?? "";
    }
    if (request.args[0] !== "graphql") {
      posts.push(payloadSchema.parse(JSON.parse(request.input ?? "{}")));
      return (handlers.post ?? (() => answered(review("COMMENTED"))))();
    }
    const query = field("query");
    if (query.includes("addPullRequestReviewThreadReply")) {
      writes.push(`reply ${field("thread")} ${field("body")}`);
      return (handlers.reply ?? (() => answered(replied)))(field("thread"));
    }
    if (query.includes("unresolveReviewThread")) {
      writes.push(`unresolve ${field("thread")}`);
      return (handlers.unresolve ?? (() => answered(unresolved)))(field("thread"));
    }
    reads.push(1);
    return (handlers.read ?? (() => answered(prAnswer())))();
  });
  return { posts, writes, reads };
}

const replied = { data: { addPullRequestReviewThreadReply: { comment: { id: "c" } } } };
const unresolved = { data: { unresolveReviewThread: { thread: { isResolved: false } } } };
function review(state: string) {
  return { node_id: "R1", html_url: "https://github.com/example/one/pull/7#r1", state };
}

function thread(id: string, change: Record<string, unknown> = {}) {
  return {
    id,
    isResolved: false,
    resolvedBy: null,
    starter: { nodes: [{ author: { login: "me" } }] },
    comments: { nodes: [] },
    ...change,
  };
}

async function draft(change: Record<string, unknown> = {}) {
  await Bun.write(
    files(home.paths, { repository: "example/one", id: "r1" }).draft,
    JSON.stringify({ reviewedCommit: h2, summary: "S.", ...change }),
    { createPath: true },
  );
}

function reviewing(change: Partial<Omit<Row, "id">> = {}) {
  return seedRequest(home.paths, {
    state: "reviewing",
    launchState: "running",
    head: h2,
    name: "reviewer",
    trigger: "reply",
    headMoves: 1,
    ...change,
  });
}

test("a URL that is no PR is refused before any read", async () => {
  const calls = github({});
  expect(await post({ paths: home.paths, url: "https://example.com/7" })).toMatchObject({
    tag: "Err",
    error: { reason: "review_url_invalid" },
  });
  expect(calls.reads).toEqual([]);
});

test("a PR with no request is refused, and GitHub gets no post", async () => {
  const calls = github({});
  expect(await post({ paths: home.paths, url })).toMatchObject({
    tag: "Err",
    error: { reason: "review_request_missing" },
  });
  expect(calls.posts).toEqual([]);
});

test("a clean draft of the live head approves once and ends the round with its Slack effects", async () => {
  reviewing({ slackChannel: "C1", slackTs: "1.5", resolvedThreads: '["old"]' });
  await draft();
  const calls = github({
    read: () =>
      answered(prAnswer({ reviewThreads: { nodes: [thread("T9", { isResolved: true })] } })),
    post: () => answered(review("APPROVED")),
  });
  const posted = await post({ paths: home.paths, url });
  expect(posted).toMatchObject({
    tag: "Ok",
    value: {
      reason: "review_posted",
      data: {
        id: "r1",
        state: "approved",
        event: "APPROVE",
        threadOperations: [],
        blockers: 0,
        niceToHaves: 0,
        headLimit: null,
        review: { round: 1, event: "APPROVE", url: "https://github.com/example/one/pull/7#r1" },
      },
    },
  });
  expect(calls.posts).toMatchObject([{ commit_id: h2, event: "APPROVE" }]);
  expect(calls.posts[0]?.comments).toBeUndefined();
  expect(calls.posts[0]?.body.startsWith(`${marker}\n**Approved**`)).toBe(true);
  const after = readRequest(home.paths);
  // The post keeps the lease for the reviewer cleanup, which the review command runs next.
  expect(after.request).toMatchObject({
    state: "approved",
    ownerPid: process.pid,
    cleanupState: "pending",
    trigger: null,
    headMoves: 0,
    failureReason: null,
    resolvedThreads: '["T9"]',
  });
  expect(after.rounds).toMatchObject([
    {
      number: 1,
      trigger: "reply",
      reviewedCommit: h2,
      event: "APPROVE",
      outcome: "posted",
      reviewId: "R1",
      postedAt: now,
      marker,
      warning: null,
      blockers: "[]",
    },
  ]);
  expect(DeviceState.readSlack(home.paths, "C1")).toMatchObject({
    tag: "Ok",
    value: {
      effects: [
        { kind: "reaction", content: "white_check_mark" },
        { kind: "reply", content: "Approved · [review](https://github.com/example/one/pull/7#r1)" },
      ],
    },
  });
});

test("blockers, inline findings, and thread replies post as a comment, and an explained resolved thread reopens", async () => {
  reviewing({ trigger: null });
  await draft({
    blockers: [{ short: "Fix it", detail: "It breaks.", path: "feature.ts", line: 3 }],
    niceToHaves: [{ short: "Rename it", detail: "Rename it." }],
    threadReplies: [
      { threadId: "T1", kind: "explain", body: "Still wrong." },
      { threadId: "T2", kind: "acknowledge", body: "Fair." },
    ],
  });
  const calls = github({
    read: () =>
      answered(
        prAnswer({
          reviewThreads: {
            nodes: [
              thread("T1", { isResolved: true, resolvedBy: { login: "author" } }),
              thread("T2", { isResolved: true, resolvedBy: { login: "author" } }),
              thread("T3", { isResolved: true }),
              thread("T4", { isResolved: true, starter: { nodes: [{ author: null }] } }),
            ],
          },
        }),
      ),
  });
  const posted = await post({ paths: home.paths, url });
  expect(posted).toMatchObject({
    tag: "Ok",
    value: {
      reason: "review_posted",
      data: {
        state: "watching",
        event: "COMMENT",
        blockers: 2,
        niceToHaves: 1,
        threadOperations: [
          { threadId: "T1", kind: "reply", state: "done", detail: null },
          { threadId: "T1", kind: "unresolve", state: "done", detail: null },
          { threadId: "T2", kind: "reply", state: "done", detail: null },
        ],
      },
    },
  });
  expect(calls.posts).toMatchObject([
    {
      commit_id: h2,
      event: "COMMENT",
      comments: [
        { path: "feature.ts", line: 3, body: "**Blocker: Fix it**\n\nIt breaks.", side: "RIGHT" },
      ],
    },
  ]);
  expect(calls.writes).toEqual([
    "reply T1 Still wrong.\n\n<!-- operator-review r1 round 1 thread T1 -->",
    "unresolve T1",
    "reply T2 Fair.\n\n<!-- operator-review r1 round 1 thread T2 -->",
  ]);
  const after = readRequest(home.paths);
  expect(after.request).toMatchObject({ state: "watching", resolvedThreads: '["T2","T3"]' });
  expect(after.rounds).toMatchObject([
    { trigger: "first", event: "COMMENT", blockers: '["Fix it","1 review thread stays open"]' },
  ]);
  expect(after.operations.map((operation) => operation.state)).toEqual(["done", "done", "done"]);
});

test("a refused thread write is recorded as failed, and the round still ends", async () => {
  reviewing();
  await draft({
    threadReplies: [
      { threadId: "T1", kind: "acknowledge", body: "Fair." },
      { threadId: "T2", kind: "explain", body: "Still wrong." },
    ],
  });
  github({
    read: () =>
      answered(
        prAnswer({ reviewThreads: { nodes: [thread("T1"), thread("T2", { isResolved: true })] } }),
      ),
    reply: (id) =>
      id === "T1"
        ? answered({ errors: [{ message: "Locked." }, { message: "Try later." }] })
        : answered(replied),
    unresolve: () => answered({ errors: [{ message: "No." }] }),
  });
  expect(await post({ paths: home.paths, url })).toMatchObject({
    tag: "Ok",
    value: {
      data: {
        state: "watching",
        threadOperations: [
          { threadId: "T1", kind: "reply", state: "failed", detail: "Locked. Try later." },
          { threadId: "T2", kind: "reply", state: "done", detail: null },
          { threadId: "T2", kind: "unresolve", state: "failed", detail: "No." },
        ],
      },
    },
  });
  expect(readRequest(home.paths).request?.resolvedThreads).toBe('["T2"]');
});

test("a lost thread answer keeps the request posting, and the retry reads the thread before it writes", async () => {
  reviewing();
  await draft({
    threadReplies: [
      { threadId: "T1", kind: "acknowledge", body: "One." },
      { threadId: "T2", kind: "acknowledge", body: "Two." },
    ],
  });
  const threads = { nodes: [thread("T1"), thread("T2")] };
  const calls = github({
    read: () => answered(prAnswer({ reviewThreads: threads })),
    reply: (id) =>
      id === "T2" ? { status: "uncertain", detail: "The call timed out." } : answered(replied),
  });
  expect(await post({ paths: home.paths, url })).toMatchObject({
    tag: "Err",
    error: {
      reason: "github_uncertain",
      detail:
        "GitHub did not confirm the reply in thread T2: The call timed out. Run the post again. It reads the thread first, so it does not reply twice.",
    },
  });
  const lost = readRequest(home.paths);
  expect(lost.request).toMatchObject({ state: "posting", ownerPid: null });
  expect(lost.rounds).toMatchObject([{ outcome: "posted" }]);
  expect(lost.operations.map((operation) => `${operation.threadId} ${operation.state}`)).toEqual([
    "T1 done",
    "T2 pending",
  ]);
  // GitHub holds the lost reply, so the retry marks it done without a second write.
  const retried = github({
    read: () =>
      answered(
        prAnswer({
          reviewThreads: {
            nodes: [
              thread("T1"),
              thread("T2", {
                comments: {
                  nodes: [
                    {
                      id: "c2",
                      body: "Two.\n\n<!-- operator-review r1 round 1 thread T2 -->",
                      createdAt: now,
                      author: { login: "me" },
                    },
                  ],
                },
              }),
            ],
          },
        }),
      ),
  });
  expect(calls.writes).toHaveLength(2);
  expect(await post({ paths: home.paths, url })).toMatchObject({
    tag: "Ok",
    value: {
      reason: "review_posted",
      data: {
        state: "watching",
        threadOperations: [
          { threadId: "T1", state: "done" },
          { threadId: "T2", state: "done" },
        ],
      },
    },
  });
  expect(retried.writes).toEqual([]);
  expect(retried.posts).toEqual([]);
});

test("a thread write that stops is uncertain", async () => {
  reviewing();
  await draft({ threadReplies: [{ threadId: "T1", kind: "acknowledge", body: "One." }] });
  github({
    read: () => answered(prAnswer({ reviewThreads: { nodes: [thread("T1")] } })),
    reply: () => Promise.reject(new Error("spawn failed")),
  });
  expect(await post({ paths: home.paths, url })).toMatchObject({
    tag: "Err",
    error: {
      reason: "github_uncertain",
      detail:
        "GitHub did not confirm the reply in thread T1: The write stopped. Run the post again. It reads the thread first, so it does not reply twice.",
    },
  });
});

test("a refused post returns the request to its reviewer with the failure", async () => {
  reviewing();
  await draft();
  github({ post: () => ({ status: "failed", code: "HTTP 422", detail: "Bad.", httpStatus: 422 }) });
  expect(await post({ paths: home.paths, url })).toMatchObject({
    tag: "Err",
    error: {
      reason: "review_post_failed",
      detail: "GitHub refused the review: HTTP 422: Bad. Correct the draft and post again.",
    },
  });
  const after = readRequest(home.paths);
  expect(after.request).toMatchObject({
    state: "reviewing",
    failureReason: "review_post_failed",
    failureDetail: "HTTP 422: Bad.",
    ownerPid: null,
  });
  expect(after.rounds).toMatchObject([{ number: 1, outcome: "failed" }]);
});

test("a lost post stays posting, and the retry finds the review by its marker instead of posting again", async () => {
  reviewing();
  await draft();
  const first = github({ post: () => ({ status: "uncertain", detail: "Timed out." }) });
  expect(await post({ paths: home.paths, url })).toMatchObject({
    tag: "Err",
    error: {
      reason: "github_uncertain",
      detail:
        "GitHub did not confirm the review: Timed out. Run the post again. It first looks for this review, so it does not post twice.",
    },
  });
  expect(first.posts).toHaveLength(1);
  const lost = readRequest(home.paths);
  expect(lost.request).toMatchObject({ state: "posting", ownerPid: null, failureReason: null });
  expect(lost.rounds).toMatchObject([{ outcome: "uncertain" }]);
  const retried = github({
    read: () =>
      answered(
        prAnswer({
          reviews: {
            nodes: [
              {
                id: "other",
                url: "o",
                body: `${marker} by someone else`,
                state: "COMMENTED",
                author: { login: "author" },
              },
              {
                id: "R7",
                url: "found",
                body: `${marker}\nbody`,
                state: "APPROVED",
                author: { login: "me" },
              },
            ],
          },
        }),
      ),
  });
  expect(await post({ paths: home.paths, url })).toMatchObject({
    tag: "Ok",
    value: { reason: "review_posted", data: { state: "approved", event: "APPROVE" } },
  });
  expect(retried.posts).toEqual([]);
  expect(readRequest(home.paths).rounds).toMatchObject([
    { outcome: "posted", reviewId: "R7", reviewUrl: "found", event: "APPROVE" },
  ]);
});

test("a retry with no review on an unchanged PR posts the recorded round once", async () => {
  reviewing();
  await draft({
    niceToHaves: [{ short: "Rename", detail: "Rename.", path: "feature.ts", line: 2 }],
  });
  github({ post: () => ({ status: "uncertain", detail: "Timed out." }) });
  await post({ paths: home.paths, url });
  await draft({ summary: "A changed draft is ignored." });
  const retried = github({ post: () => answered(review("COMMENTED")) });
  expect(await post({ paths: home.paths, url })).toMatchObject({
    tag: "Ok",
    value: { reason: "review_posted", data: { state: "watching", event: "COMMENT" } },
  });
  expect(retried.posts[0]?.body.includes("\n\nS.\n\n")).toBe(true);
  expect(retried.posts).toMatchObject([
    {
      commit_id: h2,
      event: "APPROVE",
      comments: [
        {
          path: "feature.ts",
          line: 2,
          body: "**Nice to have: Rename**\n\nRename.",
          side: "RIGHT",
        },
      ],
    },
  ]);
});

test("a retry posts the line comments of a round that an earlier release stored", async () => {
  reviewing();
  await draft();
  github({ post: () => ({ status: "uncertain", detail: "Timed out." }) });
  await post({ paths: home.paths, url });
  // The earlier release stored a blocker `breach` and a nice to have with no `short`.
  const [stored] = readRequest(home.paths).rounds;
  const legacy = DeviceState.changeReviewRequest(home.paths, { ...target, id: "r1" }, () =>
    Ok({
      round: {
        ...(stored ?? expect.unreachable("The round was not stored.")),
        draft: JSON.stringify({
          reviewedCommit: h2,
          summary: "S.",
          blockers: [
            {
              short: "Fix it",
              detail: "It breaks.",
              path: "feature.ts",
              line: 3,
              breach: { source: "opinions", rule: "Verify every guard." },
            },
          ],
          niceToHaves: [{ detail: "Rename.", path: "feature.ts", line: 2 }],
        }),
      },
    }),
  );
  expect(legacy.tag).toBe("Ok");
  const retried = github({ post: () => answered(review("COMMENTED")) });
  expect(await post({ paths: home.paths, url })).toMatchObject({
    tag: "Ok",
    value: { reason: "review_posted" },
  });
  expect(retried.posts).toMatchObject([
    {
      comments: [
        { path: "feature.ts", line: 3, body: "**Blocker: Fix it**\n\nIt breaks." },
        { path: "feature.ts", line: 2, body: "**Nice to have**\n\nRename." },
      ],
    },
  ]);
});

test("a retry with no review on a moved PR fails the round and posts nothing", async () => {
  reviewing();
  await draft();
  github({ post: () => ({ status: "uncertain", detail: "Timed out." }) });
  await post({ paths: home.paths, url });
  const retried = github({ read: () => answered(prAnswer({ headRefOid: h1 })) });
  expect(await post({ paths: home.paths, url })).toMatchObject({
    tag: "Err",
    error: {
      reason: "review_head_moved",
      detail: `GitHub has no review from the lost post, and PR #7 is no longer open at ${h2}. Write a new draft for the current head. Nothing was posted.`,
    },
  });
  expect(retried.posts).toEqual([]);
  const after = readRequest(home.paths);
  expect(after.request).toMatchObject({
    state: "reviewing",
    failureReason: "review_head_moved",
    failureDetail: "The PR changed after a lost post.",
  });
  expect(after.rounds).toMatchObject([{ outcome: "failed" }]);
});

test("a retry with no review on a closed PR posts nothing", async () => {
  reviewing();
  await draft();
  github({ post: () => ({ status: "uncertain", detail: "Timed out." }) });
  await post({ paths: home.paths, url });
  const retried = github({ read: () => answered(prAnswer({ state: "CLOSED" })) });
  expect(await post({ paths: home.paths, url })).toMatchObject({
    tag: "Err",
    error: { reason: "review_head_moved" },
  });
  expect(retried.posts).toEqual([]);
});

test("a posting request with no round is a defect", async () => {
  reviewing({ state: "posting" });
  github({});
  expect(await post({ paths: home.paths, url })).toMatchObject({
    tag: "Err",
    error: { reason: "review_defect", detail: "The retry lost its round." },
  });
});

test("a missing or invalid draft is refused before GitHub sees a post", async () => {
  reviewing();
  const calls = github({});
  const file = files(home.paths, { repository: "example/one", id: "r1" }).draft;
  expect(await post({ paths: home.paths, url })).toMatchObject({
    tag: "Err",
    error: {
      reason: "review_draft_missing",
      detail: `Write the draft to ${file} before the post. Nothing was posted.`,
    },
  });
  await Bun.write(file, "{");
  expect(await post({ paths: home.paths, url })).toMatchObject({
    tag: "Err",
    error: {
      reason: "review_draft_invalid",
      detail: `✖ The draft is not JSON.\nCorrect ${file}. Nothing was posted.`,
    },
  });
  await draft({ reviewedCommit: "short" });
  expect(await post({ paths: home.paths, url })).toMatchObject({
    tag: "Err",
    error: { reason: "review_draft_invalid" },
  });
  expect(calls.posts).toEqual([]);
  expect(readRequest(home.paths).request?.state).toBe("reviewing");
});

test.skipIf(asRoot)("an unreadable draft is an I/O failure", async () => {
  reviewing();
  github({});
  const file = files(home.paths, { repository: "example/one", id: "r1" }).draft;
  await draft();
  await chmod(file, 0o000);
  expect(await post({ paths: home.paths, url })).toMatchObject({
    tag: "Err",
    error: { reason: "review_io_failed" },
  });
});

test("a draft that the PR refuses, or an approval that waits for CI, posts nothing", async () => {
  reviewing();
  await draft({ blockers: [{ short: "Fix", detail: "D.", path: "other.ts", line: 1 }] });
  const calls = github({
    read: () =>
      answered(
        prAnswer({
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
                          name: "unit",
                          status: "IN_PROGRESS",
                          conclusion: null,
                          detailsUrl: null,
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
      ),
  });
  expect(await post({ paths: home.paths, url })).toMatchObject({
    tag: "Err",
    error: { reason: "review_draft_invalid" },
  });
  await draft();
  expect(await post({ paths: home.paths, url })).toMatchObject({
    tag: "Err",
    error: {
      reason: "review_ci_pending",
      detail:
        "A required CI check still runs, or the PR has more checks than one read returns. Post the approval after CI finishes. Nothing was posted.",
    },
  });
  expect(calls.posts).toEqual([]);
  expect(readRequest(home.paths).request?.state).toBe("reviewing");
});

test("an own PR and an assignment review only comment", async () => {
  reviewing();
  await draft();
  const own = github({ read: () => answered(prAnswer({ author: { login: "me" } })) });
  await post({ paths: home.paths, url });
  expect(own.posts.map((payload) => payload.event)).toEqual(["COMMENT"]);
});

test("an assignment review comments even with no blocker", async () => {
  reviewing({ origin: "assignment" });
  await draft();
  const calls = github({});
  await post({ paths: home.paths, url });
  expect(calls.posts.map((payload) => payload.event)).toEqual(["COMMENT"]);
});

test("a PR with no author can be approved", async () => {
  reviewing();
  await draft();
  const calls = github({ read: () => answered(prAnswer({ author: null }, "")) });
  await post({ paths: home.paths, url });
  expect(calls.posts.map((payload) => payload.event)).toEqual(["APPROVE"]);
});

test("at the head-move limit, a draft of the reviewer's head posts with the limit stated", async () => {
  reviewing({ head: h1, headMoves: 3 });
  await draft({ reviewedCommit: h1 });
  const calls = github({ post: () => answered(review("COMMENTED")) });
  const limit = { reviewedCommit: h1, head: h2, moves: 3 };
  expect(await post({ paths: home.paths, url })).toMatchObject({
    tag: "Ok",
    value: { data: { headLimit: limit, review: { headLimit: limit, commit: h1 } } },
  });
  expect(calls.posts).toMatchObject([{ commit_id: h1 }]);
  expect(readRequest(home.paths).rounds).toMatchObject([{ warning: JSON.stringify(limit) }]);
});

test("a moved PR moves the running reviewer and posts nothing", async () => {
  reviewing({ head: h1, headMoves: 0, worktreePath: "/w", branch: "b" });
  await draft({ reviewedCommit: h1 });
  const calls = github({});
  const moved = spyOn(WorkerDispatch, "moveReviewer").mockReturnValue(
    OkAsync({ mode: "fast-forward" as const }),
  );
  spyOn(Herdr, "prompt").mockReturnValue(OkAsync(null));
  expect(await post({ paths: home.paths, url })).toMatchObject({
    tag: "Err",
    error: {
      reason: "review_head_moved",
      detail: `PR #7 moved from ${h1} to ${h2} by a fast-forward. The reviewer worktree moved, and the reviewer got the new commits. Write a draft for ${h2}. Nothing was posted.`,
    },
  });
  expect(moved).toHaveBeenCalledTimes(1);
  expect(calls.posts).toEqual([]);
  expect(readRequest(home.paths).request).toMatchObject({
    state: "reviewing",
    head: h2,
    headMoves: 1,
    sync: null,
  });
});

test("a moved PR with a stopped reviewer asks for a replacement", async () => {
  reviewing({ head: h1, headMoves: 0, launchState: "interrupted" });
  await draft({ reviewedCommit: h1 });
  github({});
  expect(await post({ paths: home.paths, url })).toMatchObject({
    tag: "Err",
    error: {
      reason: "review_head_moved",
      detail: `PR #7 moved from ${h1} to ${h2}. The reviewer must be replaced. Read operator review next. Write a draft for ${h2}. Nothing was posted.`,
    },
  });
  expect(readRequest(home.paths).request).toMatchObject({ head: h2, headMoves: 1 });
});

test("a moved PR whose move is still unfinished leaves the move to the wait", async () => {
  reviewing({ head: h1, headMoves: 0, sync: JSON.stringify({ kind: "head", from: h3(), to: h1 }) });
  await draft({ reviewedCommit: h1 });
  github({});
  expect(await post({ paths: home.paths, url })).toMatchObject({
    tag: "Err",
    error: {
      reason: "review_head_moved",
      detail: `PR #7 moved to ${h2}, and a wait gives it to the reviewer now. Write a draft for ${h2}. Nothing was posted.`,
    },
  });
  expect(readRequest(home.paths).request).toMatchObject({ head: h1, headMoves: 0 });
});

function h3() {
  return "3".repeat(40);
}

test("a post that another process turned into a retry after the read posts nothing", async () => {
  reviewing();
  await draft();
  const calls = github({
    read: () => {
      DeviceState.changeReviewRequest(home.paths, { ...target, id: "r1" }, () =>
        Ok({ update: { state: "posting" } }),
      );
      return answered(prAnswer());
    },
  });
  expect(await post({ paths: home.paths, url })).toMatchObject({
    tag: "Err",
    error: {
      reason: "review_post_in_progress",
      detail: "Another process started this post. Run the post again. Nothing was posted.",
    },
  });
  expect(calls.posts).toEqual([]);
  expect(readRequest(home.paths).rounds.map((round) => round.outcome)).toEqual(["pending"]);
  // The write that found the retry took the lease. It gives it back, so the next post retries now.
  expect(readRequest(home.paths).request).toMatchObject({ state: "posting", ownerPid: null });
});

test("a retry that another process failed after the read posts nothing", async () => {
  reviewing();
  await draft();
  github({ post: () => ({ status: "uncertain", detail: "Timed out." }) });
  await post({ paths: home.paths, url });
  const read = DeviceState.readReviewRequest;
  spyOn(DeviceState, "readReviewRequest").mockImplementationOnce((paths, request) => {
    const snapshot = read(paths, request);
    DeviceState.changeReviewRequest(home.paths, { ...target, id: "r1" }, () =>
      Ok({ update: { state: "reviewing" } }),
    );
    return snapshot;
  });
  const calls = github({});
  expect(await post({ paths: home.paths, url })).toMatchObject({
    tag: "Err",
    error: { reason: "review_post_in_progress" },
  });
  expect(calls.posts).toEqual([]);
  expect(readRequest(home.paths).request).toMatchObject({ ownerPid: null });
});

test("a thread write after another process took the request stops and records nothing more", async () => {
  reviewing();
  await draft({
    threadReplies: [
      { threadId: "T1", kind: "acknowledge", body: "One." },
      { threadId: "T2", kind: "acknowledge", body: "Two." },
    ],
  });
  const calls = github({
    read: () => answered(prAnswer({ reviewThreads: { nodes: [thread("T1"), thread("T2")] } })),
    reply: () => {
      DeviceState.changeReviewRequest(home.paths, { ...target, id: "r1" }, () =>
        Ok({ update: { ownerPid: process.pid + 1 } }),
      );
      return answered(replied);
    },
  });
  expect(await post({ paths: home.paths, url })).toMatchObject({
    tag: "Err",
    error: { reason: "review_lease_lost" },
  });
  expect(calls.writes).toHaveLength(1);
  expect(readRequest(home.paths).operations.map((operation) => operation.state)).toEqual([
    "pending",
    "pending",
  ]);
});

test("a post for an unregistered repository is refused", async () => {
  const calls = github({});
  expect(
    await post({ paths: home.paths, url: "https://github.com/example/two/pull/1" }),
  ).toMatchObject({ tag: "Err", error: { reason: "review_repository_unregistered" } });
  expect(calls.reads).toEqual([]);
});
