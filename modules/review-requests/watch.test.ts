import { afterEach, beforeEach, expect, mock, setSystemTime, spyOn, test } from "bun:test";
import { Err, ErrAsync, Ok, OkAsync } from "unthrown";
import { DeviceSettings } from "../device-settings/main.ts";
import { DeviceState } from "../device-state/main.ts";
import { Environment } from "../environment/main.ts";
import { GithubApi } from "../github-api/main.ts";
import { Herdr } from "../herdr/main.ts";
import { WorkerDispatch } from "../worker-dispatch/main.ts";
import {
  answered,
  h1,
  h2,
  otherPr,
  prAnswer,
  readRequest,
  reviewHome,
  seedRequest,
  target,
  url,
} from "./home-fixture.ts";
import type { Paths, Round, Row } from "./request.ts";
import { rows, wait } from "./watch.ts";

type Home = Awaited<ReturnType<typeof reviewHome>>;
let home: Home;
const start = Date.parse("2026-02-03T04:05:06.000Z");
const environment = Environment.read();
const week = 7 * 24 * 60 * 60 * 1000;
const readRequests = DeviceState.readReviewRequests.bind(DeviceState);

/** The controlled interfaces. A sleep moves the clock, so a wait never sleeps for real. */
function defaults() {
  spyOn(Environment, "read").mockReturnValue({ ...environment, HERDR_SOCKET_PATH: "/sock" });
  spyOn(GithubApi, "call").mockResolvedValue(answered(prAnswer({ headRefOid: h1 })));
  spyOn(Herdr, "agentNames").mockReturnValue(OkAsync(["other", "rev"]));
  spyOn(Herdr, "prompt").mockReturnValue(OkAsync(null));
  spyOn(DeviceSettings, "slackReviewPolicy").mockReturnValue(OkAsync(null));
  sleeps();
  // A wait that loops without its sleep fails fast instead of spinning.
  let reads = 0;
  spyOn(DeviceState, "readReviewRequests").mockImplementation((paths) => {
    reads += 1;
    if (reads > 100)
      // oxlint-disable-next-line unthrown/no-throw -- A wait that never ends fails its test.
      throw new Error("The wait does not end.");
    return readRequests(paths);
  });
}

beforeEach(async () => {
  home = await reviewHome();
  setSystemTime(new Date(start));
  defaults();
});

afterEach(async () => {
  setSystemTime();
  mock.restore();
  await home.remove();
});

function coded(code: string) {
  return Object.assign(new Error(`failed ${code}`), { code });
}

/** Changes a recorded request in place. */
function change(fields: Partial<Omit<Row, "id">>, id = "r1", pr = target) {
  DeviceState.changeReviewRequest(home.paths, { ...pr, id }, () => Ok({ update: fields }));
}

function listed(paths: Paths) {
  const read = DeviceState.readReviewRequests(paths);
  return read.tag === "Ok" ? read.value : expect.unreachable("The requests were not read.");
}

function posted(number: number, postedAt: string): Round {
  return {
    requestId: "r1",
    number,
    trigger: "first",
    reviewedCommit: h1,
    draft: "{}",
    event: "COMMENT",
    body: "body",
    marker: "marker",
    outcome: "posted",
    reviewId: "id",
    reviewUrl: "review",
    postedAt,
    warning: null,
    blockers: null,
  };
}

/** Moves the clock by each sleep, and runs the given step once after the first sleep. */
function sleeps(after: () => void = () => {}) {
  const slept: number[] = [];
  spyOn(Bun, "sleep").mockImplementation(async (ms) => {
    const delay = Number(ms);
    // A wait that never ends fails fast instead of spinning.
    if (slept.length > 20)
      // oxlint-disable-next-line unthrown/no-throw -- A wait that never ends fails its test.
      throw new Error("The wait does not end.");
    if (slept.length === 0) after();
    slept.push(delay);
    setSystemTime(new Date(Date.now() + delay));
  });
  return slept;
}

async function waited(timeoutSeconds = 0, slack = false) {
  const result = await wait({ paths: home.paths, timeoutSeconds, slack });
  return result.tag === "Ok" ? result.value : expect.unreachable(`The wait failed: ${result.tag}`);
}

const running = { launchState: "running", herdrSocket: "/sock", name: "rev" } as const;

test("each request row names its action and command, its attention, or its wait", () => {
  const base = { herdrSocket: "/sock" };
  seedRequest(home.paths, base, "r7");
  seedRequest(home.paths, { state: "reviewing", launchState: "interrupted" }, "r8", otherPr(8));
  seedRequest(home.paths, { state: "posting" }, "r9", otherPr(9));
  seedRequest(
    home.paths,
    { state: "reviewing", launchState: "running", sync: "{}" },
    "r10",
    otherPr(10),
  );
  seedRequest(home.paths, { state: "closed", cleanupState: "pending" }, "r11", otherPr(11));
  seedRequest(home.paths, { state: "closed", cleanupState: "kept" }, "r12", otherPr(12));
  seedRequest(home.paths, { state: "watching" }, "r13", otherPr(13));
  const found = rows(home.paths, [
    ...listed(home.paths),
    ...listed(home.paths)
      .slice(0, 1)
      .map((row) => ({ ...row, request: null })),
  ]);
  function at(number: number) {
    return otherPr(number).url;
  }
  expect(found).toHaveLength(7);
  expect(found[0]).toMatchObject({
    id: "r7",
    state: "queued",
    action: "start_reviewer",
    reason: "review_queued",
    command: `operator review start ${url}`,
  });
  expect(found[1]).toMatchObject({
    action: "replace_reviewer",
    reason: "reviewer_interrupted",
    command: `operator review start ${at(8)}`,
  });
  expect(found[2]).toMatchObject({
    action: "post_review",
    reason: "review_post_uncertain",
    command: `operator review post ${at(9)}`,
  });
  expect(found[3]).toMatchObject({
    action: "wait_reviews",
    reason: "reviewer_move_unfinished",
    command: "operator review wait",
  });
  expect(found[4]).toMatchObject({
    action: "clean_reviewer",
    reason: "cleanup_pending",
    command: `operator review cleanup ${at(11)}`,
  });
  expect(found[5]).toMatchObject({ id: "r12", attention: "reviewer_work_kept" });
  expect(found[5]).not.toHaveProperty("action");
  expect(found[6]).toMatchObject({ id: "r13", wait: "review_watching" });
  expect(found[6]).not.toHaveProperty("attention");
});

test("a wait with nothing to observe times out at its deadline", async () => {
  expect(await waited()).toEqual({
    reason: "review_wait_timed_out",
    data: { events: [], requests: [], slack: null },
  });
});

test("a wait polls every thirty seconds until its deadline", async () => {
  const slept = sleeps();
  expect((await waited(45)).reason).toBe("review_wait_timed_out");
  expect(slept).toEqual([30000, 15000]);
});

test("a failed sleep ends the wait with its failure", async () => {
  spyOn(Bun, "sleep").mockRejectedValue(coded("EIO"));
  expect(await wait({ paths: home.paths, timeoutSeconds: 5, slack: false })).toMatchObject({
    tag: "Err",
    error: { reason: "review_io_failed", detail: "Error: failed EIO" },
  });
  spyOn(Bun, "sleep").mockRejectedValue("stopped");
  expect((await wait({ paths: home.paths, timeoutSeconds: 5, slack: false })).tag).toBe("Defect");
});

test("only the first pass returns for an action", async () => {
  seedRequest(home.paths);
  expect(await waited(60)).toMatchObject({
    reason: "review_actions_ready",
    data: { events: [], requests: [{ action: "start_reviewer" }], slack: null },
  });
  await home.remove();
  home = await reviewHome();
  const slept = sleeps(() => seedRequest(home.paths));
  expect(await waited(45)).toMatchObject({
    reason: "review_wait_timed_out",
    data: { requests: [{ action: "start_reviewer" }] },
  });
  expect(slept).toEqual([30000, 15000]);
});

test("a running reviewer that Herdr no longer lists in this server is interrupted", async () => {
  const agents = spyOn(Herdr, "agentNames");
  seedRequest(home.paths, { state: "watching", ...running, name: "gone" });
  seedRequest(home.paths, { state: "watching", ...running }, "r8", otherPr(8));
  seedRequest(
    home.paths,
    { state: "watching", ...running, herdrSocket: "/other", name: "other" },
    "r9",
    otherPr(9),
  );
  seedRequest(home.paths, { state: "watching", ...running, name: null }, "r10", otherPr(10));
  expect(await waited()).toMatchObject({
    reason: "review_events_observed",
    data: {
      events: [
        { url, kind: "reviewer_interrupted" },
        { url: otherPr(10).url, kind: "reviewer_interrupted" },
      ],
    },
  });
  expect(agents).toHaveBeenCalledTimes(1);
  expect(readRequest(home.paths).request?.launchState).toBe("interrupted");
  expect(readRequest(home.paths, "r8", otherPr(8)).request?.launchState).toBe("running");
  expect(readRequest(home.paths, "r9", otherPr(9)).request?.launchState).toBe("running");
  expect(readRequest(home.paths, "r10", otherPr(10)).request?.launchState).toBe("interrupted");
});

test("a reviewer check asks Herdr nothing without a running reviewer of this server", async () => {
  const agents = spyOn(Herdr, "agentNames");
  seedRequest(home.paths, { state: "watching", ...running, herdrSocket: "/other", name: "x" });
  expect((await waited()).reason).toBe("review_wait_timed_out");
  expect(agents).not.toHaveBeenCalled();
});

test("a server with no socket checks the reviewers that recorded no socket", async () => {
  spyOn(Environment, "read").mockReturnValue({ ...environment, HERDR_SOCKET_PATH: undefined });
  seedRequest(home.paths, { state: "watching", ...running, herdrSocket: null, name: "gone" });
  expect((await waited()).data).toMatchObject({ events: [{ kind: "reviewer_interrupted" }] });
});

test("a failed Herdr list interrupts nobody", async () => {
  spyOn(Herdr, "agentNames").mockReturnValue(
    ErrAsync({ reason: "herdr_failed" as const, detail: "down" }),
  );
  seedRequest(home.paths, { state: "watching", ...running, name: "gone" });
  expect((await waited()).reason).toBe("review_wait_timed_out");
  expect(readRequest(home.paths).request?.launchState).toBe("running");
});

test("a reviewer that stopped running during the check keeps its recorded state", async () => {
  seedRequest(home.paths, { state: "watching", ...running, name: "gone" });
  spyOn(Herdr, "agentNames").mockImplementation(() => {
    change({ launchState: "failed" });
    return OkAsync(["rev"]);
  });
  await waited();
  expect(readRequest(home.paths).request?.launchState).toBe("failed");
});

test("a quiet watching request is marked stale once", async () => {
  seedRequest(home.paths, { state: "watching", head: h1, activityAt: "2026-01-01T00:00:00.000Z" });
  expect(await waited()).toMatchObject({
    reason: "review_events_observed",
    data: { events: [{ url, kind: "review_stale" }], requests: [{ stale: true }] },
  });
  expect(readRequest(home.paths).request?.staleAt).toBe(new Date(start).toISOString());
  expect((await waited()).reason).toBe("review_wait_timed_out");
});

test("a request that changed during the read is not marked stale", async () => {
  seedRequest(home.paths, { state: "watching", head: h1, activityAt: "2026-01-01T00:00:00.000Z" });
  spyOn(GithubApi, "call").mockImplementation(async () => {
    change({ staleAt: "earlier" });
    return answered(prAnswer({ headRefOid: h1 }));
  });
  expect((await waited()).reason).toBe("review_wait_timed_out");
  expect(readRequest(home.paths).request?.staleAt).toBe("earlier");
  change({ staleAt: null });
  spyOn(GithubApi, "call").mockImplementation(async () => {
    change({ state: "approved" });
    return answered(prAnswer({ headRefOid: h1 }));
  });
  expect((await waited()).reason).toBe("review_wait_timed_out");
  expect(readRequest(home.paths).request?.staleAt).toBeNull();
});

test("the stale clock starts at the request, its activity, or its last post", async () => {
  setSystemTime(new Date(start - week));
  seedRequest(home.paths, { state: "watching", head: h1 });
  setSystemTime(new Date(start));
  expect((await waited()).data).toMatchObject({ events: [{ kind: "review_stale" }] });
  change({ staleAt: null, activityAt: "2026-01-01T00:00:00.000Z" });
  DeviceState.changeReviewRequest(home.paths, target, () =>
    Ok({ round: posted(1, new Date(start - 1000).toISOString()) }),
  );
  expect((await waited()).reason).toBe("review_wait_timed_out");
});

test("a merged PR ends its request and cleans up its reviewer", async () => {
  seedRequest(home.paths, { state: "watching", head: h1 });
  spyOn(GithubApi, "call").mockResolvedValue(answered(prAnswer({ state: "MERGED" })));
  expect(await waited()).toEqual({
    reason: "review_events_observed",
    data: {
      events: [
        {
          url,
          kind: "review_closed",
          prState: "MERGED",
          cleanup: { state: "done", detail: "No reviewer pane was recorded." },
        },
      ],
      requests: [],
      slack: null,
    },
  });
  expect(readRequest(home.paths).request).toMatchObject({
    state: "closed",
    cleanupState: "done",
  });
});

test("a failed cleanup of a closed PR is reported with its failure", async () => {
  seedRequest(home.paths, { state: "watching", head: h1, paneId: "p1" });
  spyOn(GithubApi, "call").mockResolvedValue(answered(prAnswer({ state: "CLOSED" })));
  let reads = 0;
  spyOn(Environment, "read").mockImplementation(() => {
    reads += 1;
    if (reads > 1)
      // oxlint-disable-next-line unthrown/no-throw -- Inject a failure at the environment interface.
      throw coded("EACCES");
    return { ...environment, HERDR_SOCKET_PATH: "/sock" };
  });
  expect((await waited()).data).toMatchObject({
    events: [
      {
        kind: "review_closed",
        prState: "CLOSED",
        cleanup: { state: "failed", reason: "review_io_failed", detail: "Error: failed EACCES" },
      },
    ],
  });
});

test("a close that the request refuses reports nothing", async () => {
  seedRequest(home.paths, {
    state: "watching",
    head: h1,
    launchState: "starting",
    ownerPid: process.pid,
    leaseAt: new Date(start).toISOString(),
  });
  spyOn(GithubApi, "call").mockResolvedValue(answered(prAnswer({ state: "CLOSED" })));
  expect((await waited()).data).toMatchObject({ events: [] });
  expect(readRequest(home.paths).request?.state).toBe("watching");
});

test("new commits start a round and give it to the running reviewer", async () => {
  seedRequest(home.paths, { state: "watching", head: h1, ...running });
  spyOn(GithubApi, "call").mockResolvedValue(answered(prAnswer({ headRefOid: h2 })));
  expect((await waited()).data).toMatchObject({
    events: [
      {
        url,
        kind: "round_started",
        trigger: "commits",
        reviewer: { kind: "head", mode: null },
      },
    ],
  });
  expect(readRequest(home.paths).request).toMatchObject({
    state: "reviewing",
    head: h2,
    sync: null,
  });
});

test("a round of a stopped reviewer names no reviewer, and is reported once", async () => {
  seedRequest(home.paths, { state: "watching", head: h1, launchState: "interrupted" });
  spyOn(GithubApi, "call").mockResolvedValue(answered(prAnswer({ headRefOid: h2 })));
  expect((await waited()).data).toHaveProperty("events", [
    { url, kind: "round_started", trigger: "commits" },
  ]);
  expect((await waited()).data).toHaveProperty("events", []);
});

test("a head move goes to the running reviewer, and a failed move is reported", async () => {
  seedRequest(home.paths, { state: "reviewing", head: h1, ...running, worktreePath: "/w" });
  spyOn(GithubApi, "call").mockResolvedValue(answered(prAnswer({ headRefOid: h2 })));
  spyOn(WorkerDispatch, "moveReviewer").mockReturnValue(
    ErrAsync({ reason: "review_fetch_failed", detail: "no remote" }),
  );
  expect((await waited()).data).toMatchObject({
    events: [
      {
        url,
        kind: "head_moved",
        from: h1,
        to: h2,
        reviewer: { kind: "failed", reason: "review_fetch_failed", detail: "no remote" },
      },
    ],
  });
  expect(readRequest(home.paths).request).toMatchObject({ head: h2, headMoves: 1 });
});

test("a head move at the limit reports nothing", async () => {
  seedRequest(home.paths, { state: "reviewing", head: h1, ...running, headMoves: 3 });
  spyOn(GithubApi, "call").mockResolvedValue(answered(prAnswer({ headRefOid: h2 })));
  expect((await waited()).data).toMatchObject({ events: [] });
  expect(readRequest(home.paths).request?.head).toBe(h1);
});

test("a request in a post asks GitHub nothing, and a failed read is reported", async () => {
  const call = spyOn(GithubApi, "call");
  seedRequest(home.paths, {
    state: "posting",
    ownerPid: process.pid,
    leaseAt: new Date(start).toISOString(),
  });
  expect((await waited()).data).toMatchObject({ events: [] });
  expect(call).not.toHaveBeenCalled();
  change({ state: "watching", ownerPid: null, leaseAt: null });
  call.mockResolvedValue({ status: "failed", code: "HTTP 502", detail: "down", httpStatus: 502 });
  expect((await waited()).data).toMatchObject({
    events: [{ url, kind: "read_failed", reason: "github_failed", detail: "HTTP 502: down" }],
  });
});

test("a thread resolved before the last post starts no round", async () => {
  const thread = {
    id: "T1",
    isResolved: true,
    resolvedBy: { login: "author" },
    starter: { nodes: [{ author: { login: "me" } }] },
    comments: { nodes: [] },
  };
  spyOn(GithubApi, "call").mockResolvedValue(
    answered(prAnswer({ headRefOid: h1, reviewThreads: { nodes: [thread] } })),
  );
  seedRequest(home.paths, { state: "watching", head: h1, resolvedThreads: '["T1"]' });
  expect((await waited()).data).toMatchObject({ events: [] });
  change({ resolvedThreads: null });
  expect((await waited()).data).toMatchObject({
    events: [{ kind: "round_started", trigger: "resolved" }],
  });
});

test("an unfinished sync is finished by the next wait", async () => {
  seedRequest(home.paths, {
    state: "reviewing",
    head: h1,
    ...running,
    sync: JSON.stringify({ kind: "round", round: 2, trigger: "reply" }),
  });
  expect(await waited()).toMatchObject({
    reason: "review_events_observed",
    data: { events: [{ url, kind: "reviewer_synced", reviewer: { kind: "round", mode: null } }] },
  });
  expect(readRequest(home.paths).request).toMatchObject({ sync: null, ownerPid: null });
});

test("a failed sync is reported once, and the move waits without an action", async () => {
  seedRequest(home.paths, {
    state: "reviewing",
    head: h1,
    ...running,
    worktreePath: "/w",
    sync: JSON.stringify({ kind: "head", from: h1, to: h2 }),
  });
  const move = spyOn(WorkerDispatch, "moveReviewer").mockReturnValue(
    ErrAsync({ reason: "review_fetch_failed", detail: "no remote" }),
  );
  expect((await waited(60)).data).toMatchObject({
    events: [
      {
        url,
        kind: "reviewer_synced",
        reviewer: { kind: "failed", reason: "review_fetch_failed", detail: "no remote" },
      },
    ],
  });
  expect(await waited()).toMatchObject({
    reason: "review_wait_timed_out",
    data: { events: [], requests: [{ action: "wait_reviews" }] },
  });
  expect(move).toHaveBeenCalledTimes(2);
});

test("a sync of an active owner is left to it", async () => {
  const move = spyOn(WorkerDispatch, "moveReviewer");
  seedRequest(home.paths, {
    state: "reviewing",
    head: h1,
    ...running,
    worktreePath: "/w",
    sync: JSON.stringify({ kind: "head", from: h1, to: h2 }),
    ownerPid: process.pid,
    leaseAt: new Date(start).toISOString(),
  });
  expect((await waited()).data).toMatchObject({ events: [] });
  expect(move).not.toHaveBeenCalled();
});

test("a pending cleanup whose process stopped is finished by the next wait", async () => {
  seedRequest(home.paths, { state: "closed", cleanupState: "pending" });
  expect(await waited()).toMatchObject({
    reason: "review_events_observed",
    data: {
      events: [
        {
          url,
          kind: "reviewer_cleaned",
          cleanup: { state: "done", detail: "No reviewer pane was recorded." },
        },
      ],
      requests: [],
    },
  });
  expect(readRequest(home.paths).request?.cleanupState).toBe("done");
});

test("a pending cleanup of an approved request whose process stopped is finished by the next wait", async () => {
  seedRequest(home.paths, {
    state: "approved",
    head: h1,
    ...running,
    paneId: "p1",
    worktreePath: "/w",
    branch: "review/b",
    cleanupState: "pending",
  });
  const close = spyOn(Herdr, "closePane").mockReturnValue(OkAsync("closed" as const));
  spyOn(WorkerDispatch, "cleanWorktree").mockResolvedValue({ state: "removed", detail: "Gone." });
  expect(await waited()).toEqual({
    reason: "review_events_observed",
    data: {
      events: [
        {
          url,
          kind: "reviewer_cleaned",
          cleanup: { state: "done", detail: "Closed pane p1. Gone." },
        },
      ],
      requests: [expect.objectContaining({ state: "approved", wait: "review_approved" })],
      slack: null,
    },
  });
  expect(close).toHaveBeenCalledWith("p1");
  expect(readRequest(home.paths).request).toMatchObject({
    state: "approved",
    cleanupState: "done",
    launchState: "interrupted",
    worktreePath: null,
    branch: null,
    ownerPid: null,
  });
});

test("a pending cleanup that fails is reported as failed", async () => {
  seedRequest(home.paths, { state: "closed", cleanupState: "pending", paneId: "p1" });
  let reads = 0;
  spyOn(Environment, "read").mockImplementation(() => {
    reads += 1;
    if (reads > 1)
      // oxlint-disable-next-line unthrown/no-throw -- Inject a failure at the environment interface.
      throw coded("EACCES");
    return { ...environment, HERDR_SOCKET_PATH: "/sock" };
  });
  expect((await waited()).data).toMatchObject({
    events: [
      {
        url,
        kind: "reviewer_cleaned",
        cleanup: { state: "failed", reason: "review_io_failed", detail: "Error: failed EACCES" },
      },
    ],
  });
});

test("a cleanup that another process holds or finished is not repeated", async () => {
  seedRequest(home.paths, {
    state: "closed",
    cleanupState: "pending",
    ownerPid: process.pid,
    leaseAt: new Date(start).toISOString(),
  });
  expect((await waited()).data).toMatchObject({ events: [] });
  change({ ownerPid: null, leaseAt: null });
  seedRequest(home.paths, { state: "watching", ...running, head: h1 }, "r8", otherPr(8));
  spyOn(Herdr, "agentNames").mockImplementation(() => {
    change({ cleanupState: "failed" });
    return OkAsync(["rev"]);
  });
  expect((await waited()).data).toMatchObject({ events: [] });
  expect(readRequest(home.paths).request?.cleanupState).toBe("failed");
});

test("a request with nothing to resume and nothing new reports nothing", async () => {
  seedRequest(home.paths, { state: "closed", cleanupState: "failed" });
  expect((await waited()).data).toMatchObject({ events: [] });
});

test("a failed pass ends the wait with its failure", async () => {
  seedRequest(home.paths, { state: "watching", ...running, head: h1 });
  spyOn(Herdr, "agentNames").mockImplementation(() => {
    // oxlint-disable-next-line unthrown/no-throw -- Inject a failure at the module interface.
    throw coded("ENOSPC");
  });
  expect(await wait({ paths: home.paths, timeoutSeconds: 0, slack: false })).toMatchObject({
    tag: "Err",
    error: { reason: "review_io_failed", detail: "Error: failed ENOSPC" },
  });
  spyOn(Herdr, "agentNames").mockImplementation(() => {
    // oxlint-disable-next-line unthrown/no-throw, no-throw-literal -- A cause that is no Error.
    throw "stopped";
  });
  expect((await wait({ paths: home.paths, timeoutSeconds: 0, slack: false })).tag).toBe("Defect");
});

const policy = { channel: "C1", repos: ["example/one"], authors: ["author"] };

function readChannel() {
  DeviceState.startSlackWatch(home.paths, "C1", "1.0");
  DeviceState.ingestSlack(home.paths, {
    channel: "C1",
    from: { cursor: "1.0", latest: null, pending: null },
    to: { cursor: "2.0", latest: null, pending: null, paging: false },
    candidates: [],
    start: [],
  });
}

function effect(failure: string | null) {
  seedRequest(home.paths, { state: "watching", head: h1, slackChannel: "C1", slackTs: "1.5" });
  const changed = DeviceState.changeReviewRequest(home.paths, target, () =>
    Ok({ effects: [{ key: "k", kind: "reply", content: "done" }] }),
  );
  const id =
    changed.tag === "Ok"
      ? DeviceState.readSlack(home.paths, "C1")
      : expect.unreachable("The effect was not recorded.");
  const pending = id.tag === "Ok" ? id.value.effects[0]?.id : undefined;
  if (failure !== null && pending !== undefined)
    DeviceState.acknowledgeSlackEffect(home.paths, pending, () => ({
      kind: "failed",
      detail: failure,
    }));
}

test("in the Slack loop, a due channel read ends the wait", async () => {
  spyOn(DeviceSettings, "slackReviewPolicy").mockReturnValue(OkAsync(policy));
  expect(await waited(60, true)).toMatchObject({
    reason: "review_slack_ready",
    data: { events: [], slack: { channel: "C1", read: { tool: "slack_read_channel" } } },
  });
});

test("outside the Slack loop, a due read only reports Slack", async () => {
  spyOn(DeviceSettings, "slackReviewPolicy").mockReturnValue(OkAsync(policy));
  expect(await waited(0, false)).toMatchObject({
    reason: "review_wait_timed_out",
    data: { slack: { channel: "C1", read: { tool: "slack_read_channel" } } },
  });
});

test("in the Slack loop, a read that is not due and no effect do not end the wait", async () => {
  spyOn(DeviceSettings, "slackReviewPolicy").mockReturnValue(OkAsync(policy));
  readChannel();
  expect(await waited(0, true)).toMatchObject({
    reason: "review_wait_timed_out",
    data: { slack: { read: null, effects: [] } },
  });
});

test("in the Slack loop, a pending effect ends the wait", async () => {
  spyOn(DeviceSettings, "slackReviewPolicy").mockReturnValue(OkAsync(policy));
  readChannel();
  effect(null);
  expect(await waited(60, true)).toMatchObject({
    reason: "review_slack_ready",
    data: { slack: { read: null, effects: [{ kind: "reply", failure: null }] } },
  });
});

test("a refused effect ends only the first pass of the Slack loop", async () => {
  spyOn(DeviceSettings, "slackReviewPolicy").mockReturnValue(OkAsync(policy));
  readChannel();
  effect("refused");
  expect(await waited(60, true)).toMatchObject({
    reason: "review_slack_ready",
    data: { slack: { effects: [{ failure: "refused" }] } },
  });
  await home.remove();
  home = await reviewHome();
  readChannel();
  const slept = sleeps(() => effect("refused"));
  expect(await waited(45, true)).toMatchObject({
    reason: "review_wait_timed_out",
    data: { slack: { effects: [{ failure: "refused" }] } },
  });
  expect(slept).toEqual([30000, 15000]);
});

test("an event ends the wait before Slack or an action", async () => {
  spyOn(DeviceSettings, "slackReviewPolicy").mockReturnValue(OkAsync(policy));
  seedRequest(home.paths, { state: "watching", ...running, name: "gone" });
  seedRequest(home.paths, {}, "r8", otherPr(8));
  expect((await waited(60, true)).reason).toBe("review_events_observed");
});

const busy = { reason: "state_busy" as const, detail: "busy" };

/** Makes every later state change fail, from inside the given interface call. */
function failChanges() {
  spyOn(DeviceState, "changeReviewRequest").mockReturnValue(Err(busy));
}

test("a row with no request is neither resumed nor observed", async () => {
  seedRequest(home.paths, { state: "watching", head: h1, sync: "{}" });
  const call = spyOn(GithubApi, "call");
  const rowsRead = listed(home.paths).map((row) => ({ ...row, request: null }));
  spyOn(DeviceState, "readReviewRequests").mockReturnValue(Ok(rowsRead));
  expect(await waited()).toEqual({
    reason: "review_wait_timed_out",
    data: { events: [], requests: [], slack: null },
  });
  expect(call).not.toHaveBeenCalled();
});

test("an ended request is never read on GitHub", async () => {
  const call = spyOn(GithubApi, "call");
  seedRequest(home.paths, { state: "closed", cleanupState: "pending" });
  seedRequest(home.paths, { state: "skipped", cleanupState: "failed" }, "r8", otherPr(8));
  await waited();
  expect(call).not.toHaveBeenCalled();
});

test("in the Slack loop with no channel set, the wait only times out", async () => {
  expect(await waited(0, true)).toEqual({
    reason: "review_wait_timed_out",
    data: { events: [], requests: [], slack: null },
  });
});

test("an interruption that the state refuses reports nothing", async () => {
  seedRequest(home.paths, { state: "watching", ...running, name: "gone" });
  spyOn(Herdr, "agentNames").mockImplementation(() => {
    failChanges();
    return OkAsync(["rev"]);
  });
  expect((await waited()).data).toMatchObject({ events: [] });
});

test("a stale mark, a close, a round, or a head move that the state refuses reports nothing", async () => {
  spyOn(GithubApi, "call").mockImplementation(async () => {
    failChanges();
    return answered(prAnswer({ headRefOid: h1 }));
  });
  seedRequest(home.paths, { state: "watching", head: h1, activityAt: "2026-01-01T00:00:00.000Z" });
  expect((await waited()).data).toMatchObject({ events: [] });
  mock.restore();
  defaults();
  spyOn(GithubApi, "call").mockImplementation(async () => {
    failChanges();
    return answered(prAnswer({ state: "MERGED" }));
  });
  expect((await waited()).data).toMatchObject({ events: [] });
  mock.restore();
  defaults();
  change({ state: "watching", activityAt: null, staleAt: "s" });
  spyOn(GithubApi, "call").mockImplementation(async () => {
    failChanges();
    return answered(prAnswer({ headRefOid: h2 }));
  });
  expect((await waited()).data).toMatchObject({ events: [] });
  mock.restore();
  defaults();
  change({ state: "reviewing" });
  spyOn(GithubApi, "call").mockImplementation(async () => {
    failChanges();
    return answered(prAnswer({ headRefOid: h2 }));
  });
  expect((await waited()).data).toMatchObject({ events: [] });
  mock.restore();
  expect(readRequest(home.paths).request).toMatchObject({
    state: "reviewing",
    head: h1,
    headMoves: 0,
    staleAt: "s",
  });
});

test("a resumed sync or cleanup that the state refuses reports nothing", async () => {
  seedRequest(home.paths, {
    state: "reviewing",
    head: h1,
    ...running,
    sync: JSON.stringify({ kind: "round", round: 2, trigger: "reply" }),
  });
  seedRequest(home.paths, { state: "closed", cleanupState: "pending" }, "r8", otherPr(8));
  const prompt = spyOn(Herdr, "prompt");
  spyOn(Herdr, "agentNames").mockImplementation(() => {
    failChanges();
    return OkAsync(["rev"]);
  });
  expect((await waited()).data).toMatchObject({ events: [] });
  expect(prompt).not.toHaveBeenCalled();
});

test("a sync or cleanup that another process took during the check is left to it", async () => {
  seedRequest(home.paths, {
    state: "reviewing",
    head: h1,
    ...running,
    sync: JSON.stringify({ kind: "round", round: 2, trigger: "reply" }),
  });
  seedRequest(home.paths, { state: "closed", cleanupState: "pending" }, "r8", otherPr(8));
  const prompt = spyOn(Herdr, "prompt");
  spyOn(Herdr, "agentNames").mockImplementation(() => {
    const lease = { ownerPid: process.ppid, leaseAt: new Date(start).toISOString() };
    change(lease);
    change(lease, "r8", otherPr(8));
    return OkAsync(["rev"]);
  });
  expect((await waited()).data).toMatchObject({ events: [] });
  expect(prompt).not.toHaveBeenCalled();
  expect(readRequest(home.paths, "r8", otherPr(8)).request?.cleanupState).toBe("pending");
});

/** Makes the next state change fail after its decision ran on the recorded request. */
function failAfterDecision() {
  spyOn(DeviceState, "changeReviewRequest").mockImplementation((paths, pr, decide) => {
    const read = DeviceState.readReviewRequest(paths, pr);
    if (read.tag === "Ok") decide({ ...read.value, ended: null });
    return Err(busy);
  });
}

test("a stale mark whose write fails reports nothing", async () => {
  seedRequest(home.paths, { state: "watching", head: h1, activityAt: "2026-01-01T00:00:00.000Z" });
  spyOn(GithubApi, "call").mockImplementation(async () => {
    failAfterDecision();
    return answered(prAnswer({ headRefOid: h1 }));
  });
  expect((await waited()).data).toMatchObject({ events: [] });
});

test("a request with nothing new changes no state", async () => {
  seedRequest(home.paths, { state: "watching", head: h1 });
  const change = spyOn(DeviceState, "changeReviewRequest");
  expect((await waited()).data).toMatchObject({ events: [] });
  expect(change).not.toHaveBeenCalled();
});

test("a close applies to the read request, not to a newer request of the PR", async () => {
  seedRequest(home.paths, { state: "watching", head: h1 });
  spyOn(GithubApi, "call").mockImplementation(async () => {
    change({ state: "skipped", endedAt: "e" });
    seedRequest(home.paths, {}, "r2");
    return answered(prAnswer({ state: "MERGED" }));
  });
  await waited();
  expect(readRequest(home.paths, "r1").request?.state).toBe("closed");
  expect(readRequest(home.paths, "r2").request?.state).toBe("queued");
});

test("a resumed sync applies to the listed request, not to a newer request of the PR", async () => {
  seedRequest(home.paths, {
    state: "reviewing",
    head: h1,
    ...running,
    sync: JSON.stringify({ kind: "round", round: 2, trigger: "reply" }),
  });
  const prompt = spyOn(Herdr, "prompt");
  spyOn(Herdr, "agentNames").mockImplementation(() => {
    change({ state: "skipped", endedAt: "e" });
    seedRequest(home.paths, {}, "r2");
    return OkAsync(["rev"]);
  });
  expect((await waited()).data).toMatchObject({
    events: [
      { kind: "reviewer_synced", reviewer: { kind: "failed", reason: "review_lease_lost" } },
    ],
  });
  expect(prompt).toHaveBeenCalledTimes(1);
});

test("a new effect ends a later pass of the Slack loop", async () => {
  spyOn(DeviceSettings, "slackReviewPolicy").mockReturnValue(OkAsync(policy));
  readChannel();
  const slept = sleeps(() => effect(null));
  expect(await waited(45, true)).toMatchObject({
    reason: "review_slack_ready",
    data: { slack: { effects: [{ failure: null }] } },
  });
  expect(slept).toEqual([30000]);
});
