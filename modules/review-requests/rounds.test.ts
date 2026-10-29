import { expect, test } from "bun:test";
import type { PullRequestFacts, Thread } from "./github.ts";
import type { RoundTrigger } from "./review-machine.ts";
import { decideWatch, resolvedAfterPost, staleAfterMs, type WatchFacts } from "./rounds.ts";

const since = "2026-10-01T00:00:00.000Z";
const later = "2026-10-02T00:00:00Z";
const earlier = "2026-09-30T00:00:00Z";

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
    head: "h1",
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
function facts(change: Partial<WatchFacts> = {}): WatchFacts {
  return {
    state: "watching",
    head: "h1",
    since,
    postedAt: since,
    resolvedThreads: [],
    staleAt: null,
    pr: pr(),
    now: Date.parse(since) + 1000,
    ...change,
  };
}

test("each trigger starts a round in its own order, and nothing new starts none", () => {
  expect(decideWatch(facts())).toEqual({ kind: "none" });
  const reply = { comments: [{ id: "c", author: "author", body: "No.", createdAt: later }] };
  const cases: [Partial<PullRequestFacts>, RoundTrigger][] = [
    [{ head: "h2" }, "commits"],
    [{ threads: [thread(reply)] }, "reply"],
    [{ comments: [{ id: "p", author: "author", body: "@me PTAL.", createdAt: later }] }, "reply"],
    [{ threads: [thread({ resolved: true, resolvedBy: "author" })] }, "resolved"],
    [{ reviewRequests: [{ reviewer: "me", createdAt: later }] }, "re-request"],
    // Commits win over the other triggers of the same read.
    [{ head: "h2", threads: [thread(reply)] }, "commits"],
  ];
  for (const [change, trigger] of cases)
    expect(decideWatch(facts({ pr: pr(change) })), trigger).toEqual({
      kind: "round",
      trigger,
      head: change.head ?? "h1",
    });
});

test("activity before the round, by the posting account, or on another thread starts no round", () => {
  const cases: Partial<PullRequestFacts>[] = [
    {
      threads: [
        thread({ comments: [{ id: "c", author: "author", body: "x", createdAt: earlier }] }),
      ],
    },
    { threads: [thread({ comments: [{ id: "c", author: "me", body: "x", createdAt: later }] })] },
    {
      threads: [
        thread({
          startedByViewer: false,
          comments: [{ id: "c", author: "author", body: "x", createdAt: later }],
        }),
      ],
    },
    { comments: [{ id: "p", author: "other", body: "@me", createdAt: later }] },
    // A conversation comment that does not mention the posting account starts no round.
    { comments: [{ id: "p", author: "author", body: "/deploy", createdAt: later }] },
    { comments: [{ id: "p", author: "author", body: "@meow see this", createdAt: later }] },
    { threads: [thread({ resolved: true, resolvedBy: "me" })] },
    { threads: [thread({ resolved: true, resolvedBy: "author", startedByViewer: false })] },
    { reviewRequests: [{ reviewer: "me", createdAt: earlier }] },
    { reviewRequests: [{ reviewer: "other", createdAt: later }] },
  ];
  for (const change of cases)
    expect(decideWatch(facts({ pr: pr(change) }))).toEqual({ kind: "none" });
  // A thread that was already resolved at the last post is not a new resolution.
  expect(
    decideWatch(
      facts({
        resolvedThreads: ["T"],
        pr: pr({ threads: [thread({ resolved: true, resolvedBy: "author" })] }),
      }),
    ),
  ).toEqual({ kind: "none" });
  // On the posting account's own PR, its own replies never count as author activity.
  expect(
    decideWatch(
      facts({
        pr: pr({
          author: "me",
          comments: [{ id: "p", author: "me", body: "@me", createdAt: later }],
        }),
      }),
    ),
  ).toEqual({ kind: "none" });
});

test("an approved request reopens only for a renewed request", () => {
  const approved = { state: "approved" };
  expect(decideWatch(facts({ ...approved, pr: pr({ head: "h2" }) }))).toEqual({ kind: "none" });
  expect(
    decideWatch(
      facts({ ...approved, pr: pr({ reviewRequests: [{ reviewer: "me", createdAt: later }] }) }),
    ),
  ).toEqual({ kind: "round", trigger: "re-request", head: "h1" });
});

test("a reviewing request observes each head move, and the machine applies the limit", () => {
  const reviewing = { state: "reviewing" };
  expect(decideWatch(facts({ ...reviewing, pr: pr({ head: "h2" }) }))).toEqual({
    kind: "head_moved",
    from: "h1",
    to: "h2",
  });
  expect(decideWatch(facts(reviewing))).toEqual({ kind: "none" });
  expect(decideWatch(facts({ ...reviewing, head: null, pr: pr({ head: "h2" }) }))).toEqual({
    kind: "none",
  });
  for (const state of ["queued", "posting"])
    expect(decideWatch(facts({ state, pr: pr({ head: "h2" }) }))).toEqual({ kind: "none" });
});

test("a merged or closed PR ends any open request", () => {
  for (const state of ["MERGED", "CLOSED"] as const)
    for (const request of ["queued", "reviewing", "watching", "approved"])
      expect(decideWatch(facts({ state: request, pr: pr({ state }) }))).toEqual({ kind: "close" });
});

test("a watching request goes stale at exactly seven quiet days, once", () => {
  const quiet = Date.parse(since);
  expect(decideWatch(facts({ now: quiet + staleAfterMs - 1 }))).toEqual({ kind: "none" });
  expect(decideWatch(facts({ now: quiet + staleAfterMs }))).toEqual({ kind: "stale" });
  expect(decideWatch(facts({ now: quiet + staleAfterMs, staleAt: since }))).toEqual({
    kind: "none",
  });
  // The last post restarts the clock.
  expect(
    decideWatch(facts({ now: quiet + staleAfterMs, postedAt: "2026-10-03T00:00:00.000Z" })),
  ).toEqual({ kind: "none" });
  expect(decideWatch(facts({ state: "approved", now: quiet + staleAfterMs }))).toEqual({
    kind: "none",
  });
  // Activity on a stale request is a round, which clears the flag.
  expect(
    decideWatch(
      facts({
        now: quiet + staleAfterMs * 2,
        staleAt: since,
        pr: pr({ comments: [{ id: "p", author: "author", body: "@me done", createdAt: later }] }),
      }),
    ),
  ).toEqual({ kind: "round", trigger: "reply", head: "h1" });
});

test("the resolved threads after a post leave out the threads that the post reopened", () => {
  const facts = pr({
    threads: [
      thread({ id: "A", resolved: true }),
      thread({ id: "B", resolved: true }),
      thread({ id: "C" }),
      thread({ id: "D", resolved: true, startedByViewer: false }),
    ],
  });
  expect(resolvedAfterPost(facts, ["B"])).toEqual(["A"]);
});

test("a renewed request that a later post already answered starts no round", () => {
  const request = [{ reviewer: "me", createdAt: later }];
  // The request came during the round, before its post.
  expect(
    decideWatch(
      facts({
        state: "approved",
        postedAt: "2026-10-03T00:00:00.000Z",
        pr: pr({ reviewRequests: request }),
      }),
    ),
  ).toEqual({ kind: "none" });
  expect(
    decideWatch(
      facts({ postedAt: "2026-10-03T00:00:00.000Z", pr: pr({ reviewRequests: request }) }),
    ),
  ).toEqual({ kind: "none" });
});

test("the stale limit is seven days", () => {
  expect(staleAfterMs).toBe(7 * 86_400_000);
});

test("activity at the round start, by a PR with no author, or with no head starts no round", () => {
  const mention = { id: "p", author: null, body: "@me PTAL.", createdAt: later };
  expect(decideWatch(facts({ pr: pr({ author: null, comments: [mention] }) }))).toEqual({
    kind: "none",
  });
  expect(
    decideWatch(
      facts({
        pr: pr({ comments: [{ id: "p", author: "author", body: "@me PTAL.", createdAt: since }] }),
      }),
    ),
  ).toEqual({ kind: "none" });
  expect(decideWatch(facts({ head: null, pr: pr({ head: "h2" }) }))).toEqual({ kind: "none" });
});

test("a mention matches the login without its other characters, in any case", () => {
  const comment = { id: "p", author: "author", body: "@MYBOT please look", createdAt: later };
  expect(decideWatch(facts({ pr: pr({ viewer: "my_bot", comments: [comment] }) }))).toEqual({
    kind: "round",
    trigger: "reply",
    head: "h1",
  });
});
