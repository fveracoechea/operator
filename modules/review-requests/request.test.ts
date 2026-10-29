import { afterEach, beforeEach, expect, mock, setSystemTime, spyOn, test } from "bun:test";
import { Ok } from "unthrown";
import { DeviceState } from "../device-state/main.ts";
import { GithubApi } from "../github-api/main.ts";
import {
  answered,
  h1,
  otherPr,
  h2,
  prAnswer,
  readRequest,
  reviewHome,
  seedRequest,
  target,
  url,
} from "./home-fixture.ts";
import {
  apply,
  files,
  latestPosted,
  openPullRequest,
  parseSync,
  parseTarget,
  qualify,
  record,
  roundNumber,
  summary,
  type Round,
} from "./request.ts";

type Home = Awaited<ReturnType<typeof reviewHome>>;
let home: Home;
const now = "2026-02-03T04:05:06.000Z";

beforeEach(async () => {
  home = await reviewHome();
  setSystemTime(new Date(now));
});

afterEach(async () => {
  setSystemTime();
  mock.restore();
  await home.remove();
});

function round(number: number, outcome: string, change: Partial<Round> = {}): Round {
  return {
    requestId: "r1",
    number,
    trigger: "first",
    reviewedCommit: h1,
    draft: "{}",
    event: "COMMENT",
    body: "body",
    marker: "marker",
    outcome,
    reviewId: `id${number}`,
    reviewUrl: `review${number}`,
    postedAt: outcome === "posted" ? now : null,
    warning: null,
    blockers: null,
    ...change,
  };
}

function coded(code: string) {
  return Object.assign(new Error(`failed ${code}`), { code });
}

function defect(cause: Error) {
  return { defect: cause.message };
}

test("only a file-system code is an I/O failure, and any other error is a defect", () => {
  for (const code of ["ENOENT", "EACCES", "EPERM", "EIO", "EROFS", "ENOSPC", "ENOTDIR", "EISDIR"])
    expect(qualify(coded(code), defect)).toEqual({
      reason: "review_io_failed",
      detail: `Error: failed ${code}`,
    });
  expect(qualify(coded("EBUSY"), defect)).toEqual({ defect: "failed EBUSY" });
  expect(qualify(new Error("plain"), defect)).toEqual({ defect: "plain" });
});

test("a PR URL gives its target, and any other text is refused", () => {
  expect(parseTarget("https://github.com/Example/One/pull/7")).toMatchObject({
    tag: "Ok",
    value: target,
  });
  expect(parseTarget("https://github.com/example/one/issues/7")).toMatchObject({
    tag: "Err",
    error: {
      reason: "review_url_invalid",
      detail:
        "Give a GitHub pull request URL, such as https://github.com/owner/repository/pull/7, not https://github.com/example/one/issues/7.",
    },
  });
});

test("only an open PR gets a review", async () => {
  const call = spyOn(GithubApi, "call").mockResolvedValue(answered(prAnswer()));
  expect(await openPullRequest(target)).toMatchObject({ tag: "Ok", value: { head: h2 } });
  call.mockResolvedValue(answered(prAnswer({ state: "MERGED" })));
  expect(await openPullRequest(target)).toMatchObject({
    tag: "Err",
    error: {
      reason: "review_pr_not_open",
      detail: "PR #7 is merged, so it gets no review. Nothing changed.",
    },
  });
});

test("the next round number follows the last posted round, and a failed post keeps its number", () => {
  expect(roundNumber([])).toBe(1);
  expect(roundNumber([round(1, "posted"), round(2, "posted")])).toBe(3);
  expect(roundNumber([round(1, "posted"), round(2, "failed")])).toBe(2);
});

test("the latest posted round skips later rounds that did not post", () => {
  expect(latestPosted([])).toBeNull();
  expect(
    latestPosted([round(1, "posted"), round(2, "posted"), round(3, "uncertain")])?.number,
  ).toBe(2);
});

test("a recorded sync parses, and no sync is null", () => {
  expect(parseSync(null)).toBeNull();
  expect(parseSync('{"kind":"round","round":2,"trigger":"reply"}')).toEqual({
    kind: "round",
    round: 2,
    trigger: "reply",
  });
  expect(parseSync(`{"kind":"head","from":"${h1}","to":"${h2}"}`)).toEqual({
    kind: "head",
    from: h1,
    to: h2,
  });
  expect(() => parseSync('{"kind":"other"}')).toThrow();
});

test("the review files of a request live in device state, by repository and request id", () => {
  const directory = `${home.paths.projects}/example/one/reviews/a%2Fb`;
  expect(files(home.paths, { repository: "example/one", id: "a/b" })).toEqual({
    directory,
    brief: `${directory}/brief.md`,
    draft: `${directory}/draft.json`,
    rounds: `${directory}/rounds`,
  });
});

test("a new request is inserted once, and a repeated add changes nothing", () => {
  const insert = {
    id: "r1",
    repository: "example/one",
    number: 7,
    url,
    origin: "slack",
    state: "queued",
  };
  const added = apply(home.paths, target, "add", () => ({ insert }));
  expect(added).toMatchObject({
    tag: "Ok",
    value: {
      transition: { insert: true, state: "queued" },
      snapshot: { request: { id: "r1", state: "queued", requestedAt: now, ownerPid: null } },
    },
  });
  const again = apply(home.paths, target, "add", () => ({ insert: { ...insert, id: "r2" } }));
  expect(again).toMatchObject({ tag: "Ok", value: { transition: { unchanged: true } } });
  expect(DeviceState.readReviewRequests(home.paths)).toMatchObject({
    tag: "Ok",
    value: [{ request: { id: "r1" } }],
  });
});

test("an unregistered repository is refused and nothing is recorded", () => {
  const other = { repository: "example/two", number: 7, url: "u" };
  expect(apply(home.paths, other, "add")).toMatchObject({
    tag: "Err",
    error: { reason: "review_repository_unregistered" },
  });
  expect(DeviceState.readReviewRequests(home.paths)).toMatchObject({ tag: "Ok", value: [] });
});

test("the payload reads the decided transition and the current request, and its rows are recorded", () => {
  seedRequest(home.paths, { slackChannel: "C1", slackTs: "1.5" });
  const seen: unknown[] = [];
  const started = apply(home.paths, target, "start", (transition, current) => {
    seen.push(transition, current.request?.state);
    return {
      update: { failureReason: "kept" },
      round: round(1, "pending"),
      operations: [
        {
          requestId: "r1",
          round: 1,
          threadId: "T",
          kind: "reply",
          body: "b",
          marker: "m",
          state: "pending",
          detail: null,
        },
      ],
      effects: [{ key: "k", kind: "reply", content: "hi" }],
    };
  });
  expect(seen).toEqual([{ launchState: "starting", lease: "hold" }, "queued"]);
  expect(started).toMatchObject({
    tag: "Ok",
    value: {
      transition: { launchState: "starting", lease: "hold" },
      snapshot: {
        request: { launchState: "starting", failureReason: "kept", ownerPid: process.pid },
        rounds: [{ number: 1, outcome: "pending" }],
        operations: [{ threadId: "T", kind: "reply" }],
      },
    },
  });
  expect(DeviceState.readSlack(home.paths, "C1")).toMatchObject({
    tag: "Ok",
    value: { effects: [{ kind: "reply", content: "hi", threadTs: "1.5" }] },
  });
});

test("an exact id selects that request", () => {
  seedRequest(home.paths, { state: "reviewing" });
  expect(apply(home.paths, target, "close", undefined, { id: "other" })).toMatchObject({
    tag: "Err",
    error: { reason: "review_request_missing" },
  });
  expect(readRequest(home.paths).request?.state).toBe("reviewing");
  expect(apply(home.paths, target, "close", undefined, { id: "r1" })).toMatchObject({
    tag: "Ok",
    value: {
      transition: { state: "closed", ended: true, cleanup: true, lease: "hold" },
      snapshot: {
        request: { state: "closed", endedAt: now, cleanupState: "pending", ownerPid: process.pid },
      },
    },
  });
});

test("a round on a moved PR moves the running reviewer and restarts the round's counts", () => {
  seedRequest(home.paths, {
    state: "watching",
    launchState: "running",
    head: h1,
    headMoves: 2,
    staleAt: "stale",
    activityAt: "old",
  });
  const started = apply(home.paths, target, "round", undefined, { trigger: "reply", to: h2 });
  expect(started).toMatchObject({
    tag: "Ok",
    value: { transition: { state: "reviewing", round: "reply", sync: true, lease: "hold" } },
  });
  const request = readRequest(home.paths).request;
  expect(request).toMatchObject({
    state: "reviewing",
    trigger: "reply",
    headMoves: 0,
    activityAt: now,
    staleAt: null,
    head: h2,
    ownerPid: process.pid,
  });
  expect(JSON.parse(request?.sync ?? "null")).toEqual({
    kind: "head",
    from: h1,
    to: h2,
    round: 1,
    trigger: "reply",
  });
});

test("a round on the reviewer's head only prompts, with the next round number", () => {
  seedRequest(home.paths, { state: "watching", launchState: "running", head: h1 });
  DeviceState.changeReviewRequest(home.paths, target, () => Ok({ round: round(1, "posted") }));
  apply(home.paths, target, "round", undefined, { trigger: "commits", to: h1 });
  const request = readRequest(home.paths).request;
  expect(request?.head).toBe(h1);
  expect(JSON.parse(request?.sync ?? "null")).toEqual({
    kind: "round",
    round: 2,
    trigger: "commits",
  });
});

test("a round with no live head keeps the recorded head", () => {
  seedRequest(home.paths, { state: "watching", launchState: "running", head: h1 });
  apply(home.paths, target, "round", undefined, { trigger: "reply" });
  const request = readRequest(home.paths).request;
  expect(request?.head).toBe(h1);
  expect(JSON.parse(request?.sync ?? "null")).toEqual({
    kind: "round",
    round: 1,
    trigger: "reply",
  });
});

test("a round for a stopped reviewer records the new head and no sync", () => {
  seedRequest(home.paths, { state: "watching", launchState: "interrupted", head: h1 });
  apply(home.paths, target, "round", undefined, { trigger: "commits", to: h2 });
  expect(readRequest(home.paths).request).toMatchObject({
    state: "reviewing",
    trigger: "commits",
    head: h2,
    sync: null,
    ownerPid: null,
  });
});

test("a round of a request with no head keeps no head", () => {
  seedRequest(home.paths, { state: "watching", launchState: "interrupted" });
  apply(home.paths, target, "round", undefined, { trigger: "commits", to: h2 });
  expect(readRequest(home.paths).request).toMatchObject({ trigger: "commits", head: null });
});

test("a head move counts once and gives the move to the running reviewer", () => {
  seedRequest(home.paths, { state: "reviewing", launchState: "running", head: h1, headMoves: 1 });
  expect(
    apply(home.paths, target, "head_moved", undefined, { observedFrom: h1, to: h2 }),
  ).toMatchObject({ tag: "Ok", value: { transition: { headMoved: true, sync: true } } });
  const request = readRequest(home.paths).request;
  expect(request).toMatchObject({ head: h2, headMoves: 2, ownerPid: process.pid });
  expect(JSON.parse(request?.sync ?? "null")).toEqual({ kind: "head", from: h1, to: h2 });
});

test("a head move of a stopped reviewer records the head with no sync", () => {
  seedRequest(home.paths, { state: "reviewing", launchState: "interrupted", head: h1 });
  apply(home.paths, target, "head_moved", undefined, { observedFrom: h1, to: h2 });
  expect(readRequest(home.paths).request).toMatchObject({ head: h2, headMoves: 1, sync: null });
});

test("a head move with no live head changes no head", () => {
  seedRequest(home.paths, { state: "reviewing", launchState: "interrupted", head: h1 });
  apply(home.paths, target, "head_moved", undefined, { observedFrom: h1 });
  expect(readRequest(home.paths).request).toMatchObject({ head: h1, headMoves: 0 });
});

test("only the process that holds the lease finishes a sync", () => {
  seedRequest(home.paths, { state: "reviewing", ownerPid: process.pid, leaseAt: now });
  expect(apply(home.paths, target, "synced", undefined, { id: "r1" })).toMatchObject({
    tag: "Ok",
    value: { snapshot: { request: { ownerPid: null } } },
  });
  const other = otherPr(8);
  seedRequest(
    home.paths,
    { state: "reviewing", ownerPid: process.pid + 1, leaseAt: now },
    "r2",
    other,
  );
  expect(apply(home.paths, other, "synced", undefined, { id: "r2" })).toMatchObject({
    tag: "Err",
    error: { reason: "review_lease_lost" },
  });
});

test("a record writes only while this process holds the request", () => {
  seedRequest(home.paths, { ownerPid: process.pid, leaseAt: now });
  expect(
    record(home.paths, target, "r1", {
      update: { failureReason: "noted" },
      round: round(1, "pending"),
      operations: [
        {
          requestId: "r1",
          round: 1,
          threadId: "T",
          kind: "reply",
          body: "b",
          marker: "m",
          state: "done",
          detail: null,
        },
      ],
    }),
  ).toMatchObject({
    tag: "Ok",
    value: {
      request: { failureReason: "noted" },
      rounds: [{ number: 1 }],
      operations: [{ state: "done" }],
    },
  });
  const other = otherPr(8);
  seedRequest(home.paths, { ownerPid: process.pid + 1, leaseAt: now }, "r2", other);
  expect(record(home.paths, other, "r2", { update: { failureReason: "lost" } })).toMatchObject({
    tag: "Err",
    error: {
      reason: "review_lease_lost",
      detail: "Another process took this review request. Nothing more was recorded.",
    },
  });
  expect(readRequest(home.paths, "r2", other).request?.failureReason).toBeNull();
});

test("a queued request with no rounds shows round one and no reviewer", () => {
  const { request } = seedRequest(home.paths);
  const located = files(home.paths, { repository: "example/one", id: "r1" });
  expect(summary(home.paths, { request, rounds: [] })).toEqual({
    id: "r1",
    url,
    repository: "example/one",
    number: 7,
    origin: "slack",
    assignment: null,
    state: "queued",
    head: null,
    round: { number: 1, trigger: "first", headMoves: 0 },
    stale: false,
    reviewer: null,
    cleanup: null,
    brief: located.brief,
    draft: located.draft,
    review: null,
  });
  expect(summary(home.paths, { request: null, rounds: [] })).toBeNull();
});

test("a watching request shows its posted round, its reviewer, and its head limit", () => {
  const { request } = seedRequest(home.paths, {
    state: "watching",
    origin: "assignment",
    sourceId: "s1",
    assignment: "a1",
    head: h1,
    headMoves: 3,
    staleAt: now,
    launchState: "running",
    name: "reviewer",
    branch: "review/b",
    paneId: "p1",
    worktreePath: "/w",
    failureReason: "why",
    failureDetail: "detail",
    cleanupState: "failed",
    cleanupDetail: "busy",
  });
  const limit = { reviewedCommit: h1, head: h2, moves: 3 };
  const rounds = [
    round(1, "posted", { warning: JSON.stringify(limit), event: "APPROVE" }),
    round(2, "failed"),
  ];
  expect(summary(home.paths, { request, rounds })).toMatchObject({
    origin: "assignment",
    assignment: { sourceId: "s1", assignment: "a1" },
    state: "watching",
    head: h1,
    round: { number: 1, trigger: null, headMoves: 3 },
    stale: true,
    reviewer: {
      state: "running",
      name: "reviewer",
      branch: "review/b",
      paneId: "p1",
      worktreePath: "/w",
      failure: { reason: "why", detail: "detail" },
    },
    cleanup: { state: "failed", detail: "busy" },
    review: { round: 1, event: "APPROVE", url: "review1", commit: h1, headLimit: limit },
  });
});

test("the round number of an approved request is its posted round, and of others the next one", () => {
  const rounds = [round(1, "posted"), round(2, "failed")];
  const approved = seedRequest(home.paths, { state: "approved", trigger: "reply" }).request;
  expect(summary(home.paths, { request: approved, rounds })).toMatchObject({
    round: { number: 1, trigger: "reply" },
    reviewer: null,
    review: { round: 1, headLimit: null },
  });
  const reviewing = seedRequest(
    home.paths,
    { state: "reviewing", launchState: "failed" },
    "r2",
    otherPr(8),
  ).request;
  expect(summary(home.paths, { request: reviewing, rounds: [round(1, "posted")] })).toMatchObject({
    round: { number: 2, trigger: null },
    reviewer: { state: "failed", failure: null },
  });
  const watching = seedRequest(home.paths, { state: "watching" }, "r3", otherPr(9)).request;
  expect(summary(home.paths, { request: watching, rounds: [] })).toMatchObject({
    round: { number: 0, trigger: "first" },
  });
});

test("a transition with no round, end, or move keeps the round fields", () => {
  seedRequest(home.paths, { staleAt: "stale", headMoves: 2, activityAt: "old", trigger: "reply" });
  apply(home.paths, target, "start");
  expect(readRequest(home.paths).request).toMatchObject({
    launchState: "starting",
    staleAt: "stale",
    headMoves: 2,
    activityAt: "old",
    trigger: "reply",
    endedAt: null,
    cleanupState: null,
    sync: null,
  });
});

test("a head move that another observer saw first changes nothing", () => {
  seedRequest(home.paths, { state: "reviewing", launchState: "running", head: h1 });
  expect(
    apply(home.paths, target, "head_moved", undefined, { observedFrom: h2, to: h2 }),
  ).toMatchObject({ tag: "Ok", value: { transition: { unchanged: true } } });
  expect(readRequest(home.paths).request).toMatchObject({ head: h1, headMoves: 0, sync: null });
});

test("a record for an unknown request is a lost lease", () => {
  expect(record(home.paths, target, "missing", { update: { failureReason: "x" } })).toMatchObject({
    tag: "Err",
    error: { reason: "review_lease_lost" },
  });
});
