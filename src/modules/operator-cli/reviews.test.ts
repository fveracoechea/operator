import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { ErrAsync, fromSafePromise, OkAsync } from "unthrown";
import { Environment } from "../environment/main.ts";
import { OperatorHome } from "../operator-home/main.ts";
import { ReviewRequests } from "../review-requests/main.ts";
import { reviewArgs, runReviews } from "./reviews.ts";

const paths = OperatorHome.resolve(Environment.parse({ HOME: "/isolated" }));
const url = "https://github.com/o/r/pull/1";
const thread = "https://example.slack.com/archives/C0123/p1234000005";
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
  };
}
test("parses each review command with its own flags and defaults", () => {
  const defaults = { profile: undefined, timeout: 300, slackThread: undefined, all: false };
  for (const command of ["add", "post", "skip", "cleanup", "start"] as const)
    expect(reviewArgs(["review", command, url])).toEqual({ ...defaults, command, url });
  expect(reviewArgs(["review", "add", url, "--slack-thread", thread])).toEqual({
    ...defaults,
    command: "add",
    url,
    slackThread: thread,
  });
  expect(reviewArgs(["review", "start", url, "--profile", "fast", "--json"])).toEqual({
    ...defaults,
    command: "start",
    url,
    profile: "fast",
  });
  expect(reviewArgs(["review", "wait", "--timeout", "45", "--all"])).toEqual({
    ...defaults,
    command: "wait",
    url: "",
    timeout: 45,
    all: true,
  });
  expect(reviewArgs(["review", "next", "--json"])).toEqual({
    ...defaults,
    command: "next",
    url: "",
  });
});
test.each([
  [["other", "add", url]],
  [["review"]],
  [["review", "close", url]],
  [["review", "add"]],
  [["review", "add", "--json"]],
  [["review", "add", url, "--json", "--json"]],
  [["review", "add", url, "--slack-thread"]],
  [["review", "add", url, "--slack-thread", "https://evil.com/archives/C/p1"]],
  [["review", "add", url, "--slack-thread", thread, "--slack-thread", thread]],
  [["review", "post", url, "--slack-thread", thread]],
  [["review", "add", url, "--profile", "fast"]],
  [["review", "start", url, "--profile"]],
  [["review", "start", url, "--profile", "--json"]],
  [["review", "start", url, "--profile", "a", "--profile", "b"]],
  [["review", "wait", "--timeout", "abc"]],
  [["review", "wait", "--timeout", "123456"]],
  [["review", "wait", "--timeout", "1", "--timeout", "2"]],
  [["review", "wait", "--slack"]],
  [["review", "next", "--all"]],
  [["review", "ingest", "--input", "-"]],
  [["review", "slack-done", "e1", "--input", "-"]],
  [["review", "slack-drop", "e1", "--person-instructed"]],
])("refuses invalid review arguments %j", async (args) => {
  expect(reviewArgs(args)).toBeNull();
  expect(await runReviews(args, paths, true)).toBe(false);
});
test("passes each command to the matching review operation", async () => {
  const called = spies();
  quiet();
  await runReviews(["review", "add", url, "--slack-thread", thread], paths, true);
  expect(called.add).toHaveBeenCalledWith({ paths, url, slackThread: thread });
  await runReviews(["review", "start", url, "--profile", "fast"], paths, true);
  expect(called.start).toHaveBeenCalledWith({ paths, url, profile: "fast" });
  for (const command of ["post", "skip", "cleanup"] as const) {
    await runReviews(["review", command, url], paths, true);
    expect(called[command]).toHaveBeenCalledWith({ paths, url });
  }
  await runReviews(["review", "wait", "--timeout", "9"], paths, true);
  expect(called.wait).toHaveBeenCalledWith({ paths, timeoutSeconds: 9, all: false });
  await runReviews(["review", "next"], paths, true);
  expect(called.next).toHaveBeenCalledWith(paths);
  for (const call of Object.values(called)) expect(call).toHaveBeenCalledTimes(1);
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
  ["review_author_excluded", 2],
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
