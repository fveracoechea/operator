import { afterEach, expect, mock, spyOn, test } from "bun:test";
// Bun has no platform temporary-root API.
import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { ErrAsync, fromSafePromise, OkAsync } from "unthrown";
import { Environment } from "../environment/main.ts";
import { OperatorHome } from "../operator-home/main.ts";
import { ReviewRequests } from "../review-requests/main.ts";
import { reviewArgs, runReviews } from "./reviews.ts";

const paths = OperatorHome.resolve(
  Environment.parse({
    HOME: "/isolated",
    XDG_CONFIG_HOME: "/isolated/config",
    XDG_STATE_HOME: "/isolated/state",
  }),
);
const url = "https://github.com/o/r/pull/1";

afterEach(() => {
  mock.restore();
  process.exitCode = 0;
});

function quiet() {
  return {
    log: spyOn(console, "log").mockImplementation(() => {}),
    error: spyOn(console, "error").mockImplementation(() => {}),
  };
}

function completed(reason: string) {
  return OkAsync({ reason, data: { review: 1 } }) as never;
}

function spies() {
  return {
    add: spyOn(ReviewRequests, "add").mockReturnValue(completed("review_added")),
    start: spyOn(ReviewRequests, "start").mockReturnValue(completed("review_started")),
    post: spyOn(ReviewRequests, "post").mockReturnValue(completed("review_posted")),
    skip: spyOn(ReviewRequests, "skip").mockReturnValue(completed("review_skipped")),
    cleanup: spyOn(ReviewRequests, "cleanup").mockReturnValue(completed("review_cleaned")),
    wait: spyOn(ReviewRequests, "wait").mockReturnValue(completed("review_waited")),
    next: spyOn(ReviewRequests, "next").mockReturnValue(completed("review_next")),
    ingest: spyOn(ReviewRequests, "ingest").mockReturnValue(completed("slack_ingested")),
    acknowledge: spyOn(ReviewRequests, "acknowledge").mockReturnValue(
      completed("slack_acknowledged"),
    ),
  };
}

test("parses each review command with its own flags and defaults", () => {
  const defaults = { profile: undefined, timeout: 300, input: "", slack: false };
  expect(reviewArgs(["review", "add", url])).toEqual({ ...defaults, command: "add", url });
  expect(reviewArgs(["review", "start", url, "--profile", "fast", "--json"])).toEqual({
    ...defaults,
    command: "start",
    url,
    profile: "fast",
  });
  expect(reviewArgs(["review", "wait", "--timeout", "45", "--slack"])).toEqual({
    ...defaults,
    command: "wait",
    url: "",
    timeout: 45,
    slack: true,
  });
  expect(reviewArgs(["review", "next", "--json"])).toEqual({
    ...defaults,
    command: "next",
    url: "",
  });
  expect(reviewArgs(["review", "ingest", "--input", "-"])).toEqual({
    ...defaults,
    command: "ingest",
    url: "",
    input: "-",
  });
  expect(reviewArgs(["review", "slack-done", "e1", "--input", "raw.json"])).toEqual({
    ...defaults,
    command: "slack-done",
    url: "e1",
    input: "raw.json",
  });
  for (const command of ["post", "skip", "cleanup"] as const)
    expect(reviewArgs(["review", command, url])).toEqual({ ...defaults, command, url });
});

test.each([
  [["other", "add", url]],
  [["review"]],
  [["review", "close", url]],
  [["review", "add"]],
  [["review", "add", "--json"]],
  [["review", "add", url, "--json", "--json"]],
  [["review", "add", url, "--slack"]],
  [["review", "add", url, "--profile", "fast"]],
  [["review", "start", url, "--profile"]],
  [["review", "start", url, "--profile", "--json"]],
  [["review", "start", url, "--profile", "a", "--profile", "b"]],
  [["review", "wait", "--timeout", "abc"]],
  [["review", "wait", "--timeout", "123456"]],
  [["review", "wait", "--timeout", "1", "--timeout", "2"]],
  [["review", "wait", "--slack", "--slack"]],
  [["review", "wait", "--input", "f"]],
  [["review", "next", "--slack"]],
  [["review", "ingest"]],
  [["review", "ingest", "--input", ""]],
  [["review", "ingest", "--input"]],
  [["review", "ingest", "--input", "--json"]],
  [["review", "ingest", "--json"]],
  [["review", "slack-done", "e1"]],
  [["review", "next", "--other", "x"]],
])("refuses %j before any review operation", async (args) => {
  const called = spies();
  expect(reviewArgs(args)).toBeNull();
  expect(await runReviews(args, paths, true)).toBe(false);
  for (const spy of Object.values(called)) expect(spy).not.toHaveBeenCalled();
});

test("passes each command to the matching review operation", async () => {
  const called = spies();
  const { log } = quiet();
  await runReviews(["review", "add", url], paths, true);
  expect(called.add).toHaveBeenCalledWith({ paths, url });
  expect(JSON.parse(String(log.mock.lastCall?.[0]))).toMatchObject({
    operation: "review_add",
    reason: "review_added",
  });
  await runReviews(["review", "start", url, "--profile", "fast"], paths, true);
  expect(called.start).toHaveBeenCalledWith({ paths, url, profile: "fast" });
  expect(JSON.parse(String(log.mock.lastCall?.[0]))).toMatchObject({ operation: "review_start" });
  await runReviews(["review", "post", url], paths, true);
  expect(called.post).toHaveBeenCalledWith({ paths, url });
  await runReviews(["review", "skip", url], paths, true);
  expect(called.skip).toHaveBeenCalledWith({ paths, url });
  await runReviews(["review", "cleanup", url], paths, true);
  expect(called.cleanup).toHaveBeenCalledWith({ paths, url });
  await runReviews(["review", "wait", "--timeout", "9", "--slack"], paths, true);
  expect(called.wait).toHaveBeenCalledWith({ paths, timeoutSeconds: 9, slack: true });
  await runReviews(["review", "next"], paths, true);
  expect(called.next).toHaveBeenCalledWith(paths);
  for (const spy of [called.ingest, called.acknowledge]) expect(spy).not.toHaveBeenCalled();
  for (const name of ["add", "start", "post", "skip", "cleanup", "wait", "next"] as const)
    expect(called[name]).toHaveBeenCalledTimes(1);
});

test("passes the raw Slack tool result from a file or from stdin", async () => {
  const called = spies();
  const { log } = quiet();
  const root = mkdtempSync(`${tmpdir()}/review-input-`);
  try {
    await Bun.write(`${root}/raw.json`, "file text");
    await runReviews(["review", "ingest", "--input", `${root}/raw.json`], paths, true);
    expect(called.ingest).toHaveBeenCalledWith({ paths, text: "file text" });
    expect(JSON.parse(String(log.mock.lastCall?.[0]))).toMatchObject({
      operation: "review_ingest",
    });
    spyOn(Bun.stdin, "text").mockResolvedValue("stdin text");
    await runReviews(["review", "slack-done", "e1", "--input", "-"], paths, true);
    expect(called.acknowledge).toHaveBeenCalledWith({ paths, id: "e1", text: "stdin text" });
    expect(JSON.parse(String(log.mock.lastCall?.[0]))).toMatchObject({
      operation: "review_slack_done",
      reason: "slack_acknowledged",
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("refuses a missing or unreadable input file and records nothing", async () => {
  const called = spies();
  const { log, error } = quiet();
  const root = mkdtempSync(`${tmpdir()}/review-input-`);
  try {
    await runReviews(["review", "ingest", "--input", `${root}/absent.json`], paths, true);
    expect(JSON.parse(String(log.mock.lastCall?.[0]))).toMatchObject({
      operation: "review_ingest",
      reason: "slack_input_missing",
    });
    expect(error).toHaveBeenLastCalledWith(expect.stringContaining(`${root}/absent.json`));
    expect(process.exitCode).toBe(3);
    await Bun.write(`${root}/locked.json`, "secret");
    chmodSync(`${root}/locked.json`, 0o000);
    await runReviews(["review", "slack-done", "e1", "--input", `${root}/locked.json`], paths, true);
    expect(JSON.parse(String(log.mock.lastCall?.[0]))).toMatchObject({
      operation: "review_slack_done",
      reason: "slack_input_unreadable",
    });
    expect(error).toHaveBeenLastCalledWith(expect.stringContaining(`${root}/locked.json`));
    expect(process.exitCode).toBe(1);
    expect(called.ingest).not.toHaveBeenCalled();
    expect(called.acknowledge).not.toHaveBeenCalled();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("reports a non-error stdin rejection as a review defect", async () => {
  const called = spies();
  const { log } = quiet();
  spyOn(Bun.stdin, "text").mockRejectedValue("closed");
  await runReviews(["review", "ingest", "--input", "-"], paths, true);
  expect(JSON.parse(String(log.mock.lastCall?.[0]))).toMatchObject({
    operation: "review_ingest",
    reason: "review_defect",
  });
  expect(process.exitCode).toBe(1);
  expect(called.ingest).not.toHaveBeenCalled();
});

test("prints a completed operation as compact JSON or as indented text", async () => {
  spies();
  const { log } = quiet();
  const expected = {
    schemaVersion: 1,
    operation: "review_post",
    outcome: "completed",
    reason: "review_posted",
    blockers: [],
    data: { review: 1 },
  };
  process.exitCode = 7;
  expect(await runReviews(["review", "post", url], paths, true)).toBe(true);
  expect(log).toHaveBeenLastCalledWith(JSON.stringify(expected));
  expect(process.exitCode).toBe(0);
  expect(await runReviews(["review", "post", url], paths, false)).toBe(true);
  expect(log).toHaveBeenLastCalledWith(JSON.stringify(expected, null, 2));
});

test.each([
  ["review_url_invalid", 2],
  ["review_start_in_progress", 4],
  ["review_post_in_progress", 4],
  ["review_reviewer_started", 4],
  ["review_already_posted", 4],
  ["review_head_moved", 4],
  ["review_start_interrupted", 4],
  ["review_post_interrupted", 4],
  ["review_approval_blocked", 4],
  ["review_ci_pending", 4],
  ["review_worktree_changed", 4],
  ["review_reviewer_moving", 4],
  ["review_request_open", 4],
  ["review_cleanup_in_progress", 4],
  ["reviewer_work_kept", 4],
  ["review_lease_lost", 4],
  ["slack_cursor_moved", 4],
  ["slack_effect_failed", 1],
  ["slack_input_unreadable", 1],
  ["state_busy", 1],
  ["state_io_failed", 1],
  ["review_io_failed", 1],
  ["review_post_failed", 1],
  ["review_fetch_failed", 1],
  ["launch_failed", 1],
  ["github_failed", 1],
  ["github_uncertain", 1],
  ["github_invalid_response", 1],
  ["review_not_found", 3],
])("refuses %s with exit code %d", async (reason, code) => {
  spyOn(ReviewRequests, "skip").mockReturnValue(
    ErrAsync({ reason, detail: "not skipped" }) as never,
  );
  const { log, error } = quiet();
  expect(await runReviews(["review", "skip", url], paths, true)).toBe(true);
  expect(JSON.parse(String(log.mock.lastCall?.[0]))).toMatchObject({
    operation: "review_skip",
    reason,
  });
  expect(error).toHaveBeenCalledWith("operator: not skipped");
  expect(process.exitCode).toBe(code);
});

test("reports a review defect with exit code 1", async () => {
  spyOn(ReviewRequests, "add").mockReturnValue(
    fromSafePromise(() => Promise.reject(new Error("boom"))) as never,
  );
  const { log, error } = quiet();
  expect(await runReviews(["review", "add", url], paths, true)).toBe(true);
  expect(JSON.parse(String(log.mock.lastCall?.[0]))).toMatchObject({
    operation: "review_add",
    reason: "review_defect",
  });
  expect(error).toHaveBeenCalledWith("operator: Error: boom");
  expect(process.exitCode).toBe(1);
});
