import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { ErrAsync, fromSafePromise, OkAsync } from "unthrown";
import { Environment } from "../environment/main.ts";
import { OperatorHome } from "../operator-home/main.ts";
import { PullRequests } from "../pull-requests/main.ts";
import { pullRequestArgs, runPullRequests } from "./pull-requests.ts";

const paths = OperatorHome.resolve(
  Environment.parse({
    HOME: "/isolated",
    XDG_CONFIG_HOME: "/isolated/config",
    XDG_STATE_HOME: "/isolated/state",
  }),
);

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
  return OkAsync({ reason, data: { pr: 7 } }) as never;
}

function spies() {
  return {
    cleanup: spyOn(PullRequests, "cleanup").mockReturnValue(completed("cleanup_completed")),
    merge: spyOn(PullRequests, "merge").mockReturnValue(completed("pr_merged")),
    associate: spyOn(PullRequests, "associate").mockReturnValue(completed("pr_associated")),
    wait: spyOn(PullRequests, "wait").mockReturnValue(completed("pr_feedback")),
  };
}

test("parses owner and cleanup commands", () => {
  expect(pullRequestArgs(["pr", "associate", "--json"])).toEqual({ operation: "pr_associate" });
  expect(pullRequestArgs(["pr", "merge"])).toEqual({ operation: "pr_merge" });
  expect(pullRequestArgs(["pr", "wait"])).toEqual({ operation: "pr_wait", timeoutSeconds: 300 });
  expect(pullRequestArgs(["pr", "wait", "--timeout", "0", "--json"])).toEqual({
    operation: "pr_wait",
    timeoutSeconds: 0,
  });
  expect(pullRequestArgs(["pr", "wait", "--timeout", "99999"])).toEqual({
    operation: "pr_wait",
    timeoutSeconds: 99999,
  });
  expect(pullRequestArgs(["cleanup", "--json", "--source", "s", "--assignment", "a"])).toEqual({
    operation: "cleanup",
    sourceId: "s",
    assignment: "a",
    personInstructed: false,
  });
  expect(
    pullRequestArgs(["cleanup", "--assignment", "a", "--person-instructed", "--source", "s"]),
  ).toEqual({ operation: "cleanup", sourceId: "s", assignment: "a", personInstructed: true });
});

test.each([
  [["other"]],
  [["other", "merge"]],
  [["pr", "wait", "--other", "5"]],
  [["cleanup", "--source", "s", "--assignment", "a", "--other", "x"]],
  [["pr"]],
  [["pr", "close"]],
  [["pr", "merge", "--json", "--json"]],
  [["pr", "associate", "--timeout", "5"]],
  [["pr", "wait", "--timeout"]],
  [["pr", "wait", "--timeout", "x5"]],
  [["pr", "wait", "--timeout", "5x"]],
  [["pr", "wait", "--timeout", "123456"]],
  [["pr", "wait", "--timeout", "5", "--timeout", "6"]],
  [["pr", "wait", "--source", "s"]],
  [["cleanup"]],
  [["cleanup", "--source", "s"]],
  [["cleanup", "--assignment", "a"]],
  [["cleanup", "--source", "s", "--source", "t", "--assignment", "a"]],
  [["cleanup", "--source", "s", "--assignment", "a", "--json", "--json"]],
  [["cleanup", "--source", "s", "--assignment"]],
  [["cleanup", "--source", "--json", "--assignment", "a"]],
  [["cleanup", "--source", "s", "--assignment", "a", "--other"]],
])("refuses %j before any pull request operation", async (args) => {
  const called = spies();
  expect(pullRequestArgs(args)).toBeNull();
  expect(await runPullRequests(args, paths, true)).toBe(false);
  for (const spy of Object.values(called)) expect(spy).not.toHaveBeenCalled();
});

test("passes each command to the matching pull request operation", async () => {
  const called = spies();
  quiet();
  const cwd = process.cwd();
  await runPullRequests(
    ["cleanup", "--source", "s", "--assignment", "a", "--person-instructed"],
    paths,
    true,
  );
  expect(called.cleanup).toHaveBeenCalledWith({
    paths,
    cwd,
    operation: "cleanup",
    sourceId: "s",
    assignment: "a",
    personInstructed: true,
  });
  await runPullRequests(["pr", "merge"], paths, true);
  expect(called.merge).toHaveBeenCalledWith({ paths, cwd });
  await runPullRequests(["pr", "associate"], paths, true);
  expect(called.associate).toHaveBeenCalledWith({ paths, cwd });
  await runPullRequests(["pr", "wait", "--timeout", "12"], paths, true);
  expect(called.wait).toHaveBeenCalledWith({ paths, cwd, timeoutSeconds: 12 });
  for (const spy of Object.values(called)) expect(spy).toHaveBeenCalledTimes(1);
});

test("prints a completed operation as compact JSON or as indented text", async () => {
  spies();
  const { log } = quiet();
  const expected = {
    schemaVersion: 1,
    operation: "pr_merge",
    outcome: "completed",
    reason: "pr_merged",
    blockers: [],
    data: { pr: 7 },
  };
  process.exitCode = 7;
  expect(await runPullRequests(["pr", "merge"], paths, true)).toBe(true);
  expect(log).toHaveBeenLastCalledWith(JSON.stringify(expected));
  expect(process.exitCode).toBe(0);
  expect(await runPullRequests(["pr", "merge"], paths, false)).toBe(true);
  expect(log).toHaveBeenLastCalledWith(JSON.stringify(expected, null, 2));
});

test.each([
  ["pr_worktree_unrecorded", 4],
  ["pr_owner_inactive", 4],
  ["pr_repository_mismatch", 4],
  ["pr_branch_mismatch", 4],
  ["pr_already_associated", 4],
  ["pr_owned_elsewhere", 4],
  ["controller_mismatch", 4],
  ["controller_identity_mismatch", 4],
  ["pr_base_invalid", 4],
  ["project_io_failed", 1],
  ["state_backup_failed", 1],
  ["state_busy", 1],
  ["state_io_failed", 1],
  ["pr_io_failed", 1],
  ["github_failed", 1],
  ["github_uncertain", 1],
  ["github_invalid_response", 1],
  ["pr_merge_refused", 1],
  ["pr_merge_unverified", 1],
  ["cleanup_failed", 1],
  ["relay_fetch_failed", 1],
  ["relay_push_failed", 1],
  ["relay_retarget_failed", 1],
  ["relay_claim_lost", 1],
  ["pr_not_found", 3],
])("refuses %s with exit code %d", async (reason, code) => {
  spyOn(PullRequests, "associate").mockReturnValue(
    ErrAsync({ reason, detail: "not associated" }) as never,
  );
  const { log, error } = quiet();
  expect(await runPullRequests(["pr", "associate", "--json"], paths, true)).toBe(true);
  expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toMatchObject({
    operation: "pr_associate",
    reason,
  });
  expect(error).toHaveBeenCalledWith("operator: not associated");
  expect(process.exitCode).toBe(code);
});

test("reports a pull request defect with exit code 1", async () => {
  spyOn(PullRequests, "wait").mockReturnValue(
    fromSafePromise(() => Promise.reject(new Error("boom"))) as never,
  );
  const { log, error } = quiet();
  expect(await runPullRequests(["pr", "wait"], paths, true)).toBe(true);
  expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toMatchObject({
    operation: "pr_wait",
    reason: "pr_defect",
  });
  expect(error).toHaveBeenCalledWith("operator: Error: boom");
  expect(process.exitCode).toBe(1);
});
