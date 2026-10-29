import { afterEach, beforeEach, expect, mock, setSystemTime, spyOn, test } from "bun:test";
import { ErrAsync, Ok, OkAsync, fromPromise } from "unthrown";
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
  prAnswer,
  readRequest,
  reviewHome,
  seedRequest,
  target,
  url,
} from "./home-fixture.ts";
import { ReviewRequests } from "./main.ts";
import type { Row } from "./request.ts";

type Home = Awaited<ReturnType<typeof reviewHome>>;
let home: Home;
const now = "2026-02-03T04:05:06.000Z";
const environment = Environment.read();

beforeEach(async () => {
  home = await reviewHome();
  setSystemTime(new Date(now));
  spyOn(Environment, "read").mockReturnValue({ ...environment, HERDR_SOCKET_PATH: "/sock" });
  spyOn(GithubApi, "call").mockResolvedValue(answered(prAnswer()));
  spyOn(Herdr, "prompt").mockReturnValue(OkAsync(null));
  spyOn(DeviceSettings, "slackReviewPolicy").mockReturnValue(OkAsync(null));
});

afterEach(async () => {
  setSystemTime();
  mock.restore();
  await home.remove();
});

function change(fields: Partial<Omit<Row, "id">>, id = "r1") {
  DeviceState.changeReviewRequest(home.paths, { ...target, id }, () => Ok({ update: fields }));
}

/** The id of the one recorded request, which an add chooses. */
function readId() {
  const read = DeviceState.readReviewRequests(home.paths);
  return read.tag === "Ok" ? (read.value[0]?.request?.id ?? "") : "";
}

function coded(code: string) {
  return Object.assign(new Error(`failed ${code}`), { code });
}

function input() {
  return { paths: home.paths, url };
}
const launched = {
  name: "rev",
  branch: "review/one-pr-7",
  host: "opencode" as const,
  model: "m",
  reasoningEffort: "high",
  profile: null,
  paneId: "p1",
  worktreePath: "/w",
  preparation: null,
  brief: "/b",
};

test("only a body that starts with the marker is an Operator review", () => {
  expect(ReviewRequests.isOperatorReview("<!-- operator-review r1 round 1 -->\nBody")).toBe(true);
  expect(ReviewRequests.isOperatorReview("Body <!-- operator-review r1 round 1 -->")).toBe(false);
});

test("an add records a queued Slack-origin request once", async () => {
  const added = await ReviewRequests.add(input());
  expect(added).toMatchObject({
    tag: "Ok",
    value: {
      reason: "review_queued",
      data: {
        url,
        repository: "example/one",
        number: 7,
        origin: "slack",
        state: "queued",
        round: { number: 1, trigger: "first" },
      },
    },
  });
  const id = readRequest(home.paths, readId()).request?.id;
  expect(id).toMatch(/^[0-9a-f-]{36}$/);
  expect(await ReviewRequests.add(input())).toMatchObject({
    tag: "Ok",
    value: { reason: "review_unchanged", data: { id, state: "queued" } },
  });
});

test("an add refuses a bad URL and a PR that is not open, and records nothing", async () => {
  expect(await ReviewRequests.add({ paths: home.paths, url: "nope" })).toMatchObject({
    tag: "Err",
    error: { reason: "review_url_invalid" },
  });
  spyOn(GithubApi, "call").mockResolvedValue(answered(prAnswer({ state: "CLOSED" })));
  expect(await ReviewRequests.add(input())).toMatchObject({
    tag: "Err",
    error: { reason: "review_pr_not_open" },
  });
  expect(DeviceState.readReviewRequests(home.paths)).toMatchObject({ tag: "Ok", value: [] });
});

test("a repeated add of a watching request with no reviewer queues a renewed round", async () => {
  seedRequest(home.paths, { state: "watching", head: h1 });
  expect(await ReviewRequests.add(input())).toMatchObject({
    tag: "Ok",
    value: {
      reason: "review_round_started",
      data: { state: "queued", head: h2, round: { trigger: "re-request" } },
    },
  });
});

test("a repeated add of a watching request gives the round to its running reviewer", async () => {
  const prompt = spyOn(Herdr, "prompt");
  seedRequest(home.paths, { state: "watching", head: h1, launchState: "running", name: "rev" });
  expect(await ReviewRequests.add(input())).toMatchObject({
    tag: "Ok",
    value: {
      reason: "review_round_started",
      data: { state: "reviewing", head: h2, round: { trigger: "re-request" } },
    },
  });
  expect(prompt).toHaveBeenCalledTimes(1);
  expect(readRequest(home.paths).request).toMatchObject({ sync: null, ownerPid: null });
});

test("a start launches the reviewer at the PR head and records it as running", async () => {
  seedRequest(home.paths, { failureReason: "old", failureDetail: "old" });
  const launch = spyOn(WorkerDispatch, "launchReviewer").mockReturnValue(OkAsync(launched));
  const release = mock(() => {});
  const hold = spyOn(DeviceState, "holdReviewRequest").mockReturnValue(release);
  expect(await ReviewRequests.start({ ...input(), profile: "deep" })).toMatchObject({
    tag: "Ok",
    value: {
      reason: "reviewer_started",
      data: { id: "r1", state: "reviewing", head: h2, launch: launched },
    },
  });
  expect(launch).toHaveBeenCalledWith(
    expect.objectContaining({ head: h2, exactHead: true, profile: "deep" }),
  );
  expect(hold).toHaveBeenCalledWith(home.paths, "r1");
  expect(release).toHaveBeenCalledTimes(1);
  expect(readRequest(home.paths).request).toMatchObject({
    launchState: "running",
    failureReason: null,
    failureDetail: null,
    ownerPid: null,
  });
});

test("a replacement keeps the recorded head", async () => {
  seedRequest(home.paths, { state: "watching", head: h1, launchState: "interrupted" });
  const launch = spyOn(WorkerDispatch, "launchReviewer").mockReturnValue(OkAsync(launched));
  expect(await ReviewRequests.start(input())).toMatchObject({
    tag: "Ok",
    value: { reason: "reviewer_replaced", data: { state: "watching", head: h1 } },
  });
  expect(launch).toHaveBeenCalledWith(expect.objectContaining({ head: h1, exactHead: false }));
});

test("a replacement of a request with no head starts at the PR head", async () => {
  seedRequest(home.paths, { state: "reviewing", launchState: "failed" });
  spyOn(WorkerDispatch, "launchReviewer").mockReturnValue(OkAsync(launched));
  expect(await ReviewRequests.start(input())).toMatchObject({
    tag: "Ok",
    value: { reason: "reviewer_replaced", data: { head: h2 } },
  });
});

test("a refused launch is recorded as failed", async () => {
  seedRequest(home.paths);
  spyOn(WorkerDispatch, "launchReviewer").mockReturnValue(
    ErrAsync({ reason: "herdr_failed", detail: "down." }),
  );
  expect(await ReviewRequests.start(input())).toMatchObject({
    tag: "Err",
    error: {
      reason: "launch_failed",
      detail:
        "herdr_failed: down. The reviewer start is recorded as failed. Read operator review next.",
    },
  });
  expect(readRequest(home.paths).request).toMatchObject({
    launchState: "failed",
    failureReason: "herdr_failed",
    failureDetail: "down.",
    ownerPid: null,
  });
});

test("a launch that stopped with a defect is recorded as failed", async () => {
  seedRequest(home.paths);
  spyOn(WorkerDispatch, "launchReviewer").mockReturnValue(
    fromPromise(Promise.reject("lost"), (cause, defect) => defect(cause)),
  );
  expect(await ReviewRequests.start(input())).toMatchObject({
    tag: "Err",
    error: {
      reason: "launch_failed",
      detail:
        "launch_defect: The start stopped: lost The reviewer start is recorded as failed. Read operator review next.",
    },
  });
  expect(readRequest(home.paths).request).toMatchObject({
    launchState: "failed",
    failureReason: "launch_defect",
    failureDetail: "The start stopped: lost",
  });
});

test("a start that cannot hold its request ends with the I/O failure", async () => {
  seedRequest(home.paths);
  const launch = spyOn(WorkerDispatch, "launchReviewer");
  spyOn(DeviceState, "holdReviewRequest").mockImplementation(() => {
    // oxlint-disable-next-line unthrown/no-throw -- Inject a file-system failure at the state interface.
    throw coded("EACCES");
  });
  expect(await ReviewRequests.start(input())).toMatchObject({
    tag: "Err",
    error: { reason: "review_io_failed", detail: "Error: failed EACCES" },
  });
  expect(launch).not.toHaveBeenCalled();
});

test("a start of a running reviewer is refused", async () => {
  seedRequest(home.paths, { state: "reviewing", launchState: "running" });
  const launch = spyOn(WorkerDispatch, "launchReviewer");
  expect(await ReviewRequests.start(input())).toMatchObject({
    tag: "Err",
    error: { reason: "review_reviewer_started" },
  });
  expect(launch).not.toHaveBeenCalled();
  expect(await ReviewRequests.start({ paths: home.paths, url: "nope" })).toMatchObject({
    tag: "Err",
    error: { reason: "review_url_invalid" },
  });
});

test("a skip ends the request and cleans up its reviewer", async () => {
  seedRequest(home.paths, { state: "reviewing", head: h1 });
  expect(await ReviewRequests.skip(input())).toMatchObject({
    tag: "Ok",
    value: {
      reason: "review_skipped",
      data: {
        id: "r1",
        state: "skipped",
        cleanup: { state: "done", detail: "No reviewer pane was recorded." },
      },
    },
  });
  expect(readRequest(home.paths).request).toMatchObject({
    state: "skipped",
    cleanupState: "done",
  });
  expect(await ReviewRequests.skip(input())).toMatchObject({
    tag: "Err",
    error: { reason: "review_request_missing" },
  });
  expect(await ReviewRequests.skip({ paths: home.paths, url: "nope" })).toMatchObject({
    tag: "Err",
    error: { reason: "review_url_invalid" },
  });
});

test("a cleanup refuses an open request and a request with no cleanup left", async () => {
  expect(await ReviewRequests.cleanup(input())).toMatchObject({
    tag: "Err",
    error: {
      reason: "review_cleanup_unchanged",
      detail: "No closed or skipped request of PR #7 has a reviewer cleanup left.",
    },
  });
  seedRequest(home.paths);
  expect(await ReviewRequests.cleanup(input())).toMatchObject({
    tag: "Err",
    error: {
      reason: "review_request_open",
      detail:
        "The review request of PR #7 is queued. Only a closed or skipped request is cleaned up. Nothing changed.",
    },
  });
  expect(await ReviewRequests.cleanup({ paths: home.paths, url: "nope" })).toMatchObject({
    tag: "Err",
    error: { reason: "review_url_invalid" },
  });
});

test("a repeated cleanup finishes a failed cleanup", async () => {
  seedRequest(home.paths, { state: "skipped", endedAt: now, cleanupState: "failed" });
  expect(await ReviewRequests.cleanup(input())).toMatchObject({
    tag: "Ok",
    value: {
      reason: "reviewer_cleaned",
      data: {
        id: "r1",
        state: "skipped",
        cleanup: { state: "done", detail: "No reviewer pane was recorded." },
      },
    },
  });
  expect(readRequest(home.paths).request?.cleanupState).toBe("done");
});

test("a cleanup that keeps unlanded work is incomplete", async () => {
  seedRequest(home.paths, {
    state: "closed",
    endedAt: now,
    cleanupState: "kept",
    worktreePath: "/w",
    branch: "b",
  });
  spyOn(WorkerDispatch, "cleanWorktree").mockResolvedValue({ state: "kept", detail: "Kept." });
  expect(await ReviewRequests.cleanup(input())).toMatchObject({
    tag: "Ok",
    value: {
      reason: "reviewer_cleanup_incomplete",
      data: { cleanup: { state: "kept", detail: "No reviewer pane was recorded. Kept." } },
    },
  });
});

test("a cleanup that another process runs is refused", async () => {
  seedRequest(home.paths, { state: "closed", endedAt: now, cleanupState: "pending" });
  change({ ownerPid: process.pid, leaseAt: now });
  expect(await ReviewRequests.cleanup(input())).toMatchObject({
    tag: "Err",
    error: { reason: "review_cleanup_in_progress" },
  });
});

test("next lists the request rows and Slack without recording a Slack watch", async () => {
  seedRequest(home.paths);
  expect(await ReviewRequests.next(home.paths)).toMatchObject({
    tag: "Ok",
    value: {
      reason: "review_next",
      data: { requests: [{ id: "r1", action: "start_reviewer" }], slack: null },
    },
  });
  spyOn(DeviceSettings, "slackReviewPolicy").mockReturnValue(
    OkAsync({ channel: "C1", repos: [], authors: [] }),
  );
  expect(await ReviewRequests.next(home.paths)).toMatchObject({
    tag: "Ok",
    value: { data: { slack: { channel: "C1" } } },
  });
  expect(DeviceState.readSlack(home.paths, "C1")).toMatchObject({
    tag: "Ok",
    value: { watch: null },
  });
});

test("the interface passes post, ingest, acknowledge, and wait to their workflows", async () => {
  expect(await ReviewRequests.post({ paths: home.paths, url: "nope" })).toMatchObject({
    tag: "Err",
    error: { reason: "review_url_invalid" },
  });
  expect(await ReviewRequests.ingest({ paths: home.paths, text: "{}" })).toMatchObject({
    tag: "Err",
    error: { reason: "slack_not_configured" },
  });
  expect(
    await ReviewRequests.acknowledge({ paths: home.paths, id: "missing", text: "{}" }),
  ).toMatchObject({ tag: "Err", error: { reason: "slack_effect_missing" } });
  expect(
    await ReviewRequests.wait({ paths: home.paths, timeoutSeconds: 0, slack: false }),
  ).toMatchObject({ tag: "Ok", value: { reason: "review_wait_timed_out" } });
});

test("an add of a request with an unfinished sync leaves the sync to a wait", async () => {
  const prompt = spyOn(Herdr, "prompt");
  seedRequest(home.paths, {
    state: "reviewing",
    head: h1,
    launchState: "running",
    name: "rev",
    sync: JSON.stringify({ kind: "round", round: 1, trigger: "reply" }),
  });
  expect(await ReviewRequests.add(input())).toMatchObject({
    tag: "Ok",
    value: { reason: "review_unchanged" },
  });
  expect(prompt).not.toHaveBeenCalled();
});

test("a first start of a request with a recorded head starts at the live PR head", async () => {
  seedRequest(home.paths, { head: h1 });
  const launch = spyOn(WorkerDispatch, "launchReviewer").mockReturnValue(OkAsync(launched));
  expect(await ReviewRequests.start(input())).toMatchObject({
    tag: "Ok",
    value: { reason: "reviewer_started", data: { head: h2 } },
  });
  expect(launch).toHaveBeenCalledWith(expect.objectContaining({ head: h2, exactHead: true }));
});
