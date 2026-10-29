import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { ErrAsync, fromSafePromise, OkAsync } from "unthrown";
import { Environment } from "../environment/main.ts";
import { OperatorHome } from "../operator-home/main.ts";
import { Projects } from "../projects/main.ts";
import { projectArgs, runProject } from "./projects.ts";

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
  return OkAsync({ reason, data: { project: "p" } }) as never;
}

function spies() {
  return {
    list: spyOn(Projects, "list").mockReturnValue(completed("projects_listed")),
    remove: spyOn(Projects, "remove").mockReturnValue(completed("project_removed")),
    move: spyOn(Projects, "move").mockReturnValue(completed("project_moved")),
    register: spyOn(Projects, "register").mockReturnValue(completed("project_registered")),
    current: spyOn(Projects, "current").mockReturnValue(completed("project_read")),
  };
}

test("parses each project command with only its own flags", () => {
  expect(projectArgs(["project", "register", "--repository", "o/r", "--json"])).toEqual({
    command: "register",
    repository: "o/r",
    personInstructed: false,
  });
  expect(projectArgs(["project", "move", "--repository", "o/r"])).toEqual({
    command: "move",
    repository: "o/r",
    personInstructed: false,
  });
  expect(projectArgs(["project", "show"])).toEqual({
    command: "show",
    repository: undefined,
    personInstructed: false,
  });
  expect(projectArgs(["project", "list", "--json"])).toEqual({
    command: "list",
    repository: undefined,
    personInstructed: false,
  });
  expect(projectArgs(["project", "remove", "o/r", "--person-instructed", "--json"])).toEqual({
    command: "remove",
    repository: "o/r",
    personInstructed: true,
  });
  expect(projectArgs(["project", "remove", "o/r"])).toEqual({
    command: "remove",
    repository: "o/r",
    personInstructed: false,
  });
});

test.each([
  [["other", "show"]],
  [["project"]],
  [["project", "rename"]],
  [["project", "remove"]],
  [["project", "remove", "--json"]],
  [["project", "show", "--json", "--json"]],
  [["project", "show", "--repository", "o/r"]],
  [["project", "list", "--person-instructed"]],
  [["project", "register", "--person-instructed"]],
  [["project", "register", "--repository"]],
  [["project", "register", "--repository", "--json"]],
  [["project", "move", "--repository", "a", "--repository", "b"]],
  [["project", "remove", "o/r", "--repository", "a"]],
  [["project", "show", "--other"]],
  [["project", "register", "--other", "x"]],
  [["project", "remove", ""]],
])("refuses %j before any project operation", async (args) => {
  const called = spies();
  expect(projectArgs(args)).toBeNull();
  expect(await runProject(args, paths, true)).toBe(false);
  for (const spy of Object.values(called)) expect(spy).not.toHaveBeenCalled();
});

test("passes each command to the matching project operation", async () => {
  const called = spies();
  quiet();
  const cwd = process.cwd();
  await runProject(["project", "list"], paths, true);
  expect(called.list).toHaveBeenCalledWith(paths);
  await runProject(["project", "remove", "o/r", "--person-instructed"], paths, true);
  expect(called.remove).toHaveBeenCalledWith({ paths, repository: "o/r", personInstructed: true });
  await runProject(["project", "move", "--repository", "o/m"], paths, true);
  expect(called.move).toHaveBeenCalledWith({ paths, cwd, repository: "o/m" });
  await runProject(["project", "register", "--repository", "o/g"], paths, true);
  expect(called.register).toHaveBeenCalledWith({ paths, cwd, repository: "o/g" });
  await runProject(["project", "show"], paths, true);
  expect(called.current).toHaveBeenCalledWith({ paths, cwd, repository: undefined });
  for (const spy of Object.values(called)) expect(spy).toHaveBeenCalledTimes(1);
});

test("prints a completed operation as compact JSON or as indented text", async () => {
  spies();
  const { log } = quiet();
  const expected = {
    schemaVersion: 1,
    operation: "project_move",
    outcome: "completed",
    reason: "project_moved",
    blockers: [],
    data: { project: "p" },
  };
  process.exitCode = 7;
  expect(await runProject(["project", "move"], paths, true)).toBe(true);
  expect(log).toHaveBeenLastCalledWith(JSON.stringify(expected));
  expect(process.exitCode).toBe(0);
  expect(await runProject(["project", "move"], paths, false)).toBe(true);
  expect(log).toHaveBeenLastCalledWith(JSON.stringify(expected, null, 2));
});

test.each([
  ["repository_choice_invalid", 2],
  ["repository_choice_required", 3],
  ["github_remote_missing", 3],
  ["git_unavailable", 3],
  ["git_checkout_invalid", 3],
  ["bare_repository", 3],
  ["linked_checkout", 3],
  ["legacy_project_state", 3],
  ["state_missing", 3],
  ["state_busy", 1],
  ["state_io_failed", 1],
  ["state_corrupt", 3],
  ["state_incompatible", 3],
  ["state_backup_failed", 1],
  ["state_migration_blocked", 3],
  ["controller_mismatch", 4],
  ["controller_identity_mismatch", 4],
  ["project_not_registered", 3],
  ["project_io_failed", 1],
  ["project_source_open", 3],
  ["project_cleanup_open", 3],
  ["project_cleanup_pending", 1],
  ["person_instruction_required", 3],
])("refuses %s with exit code %d", async (reason, code) => {
  spyOn(Projects, "register").mockReturnValue(
    ErrAsync({ reason, detail: "not registered" } as never),
  );
  const { log, error } = quiet();
  expect(await runProject(["project", "register"], paths, true)).toBe(true);
  expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toMatchObject({
    operation: "project_register",
    reason,
  });
  expect(error).toHaveBeenCalledWith("operator: not registered");
  expect(process.exitCode).toBe(code);
});

test("reports a project defect with exit code 1", async () => {
  spyOn(Projects, "list").mockReturnValue(fromSafePromise(() => Promise.reject(new Error("boom"))));
  const { log, error } = quiet();
  expect(await runProject(["project", "list"], paths, true)).toBe(true);
  expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toMatchObject({
    operation: "project_list",
    reason: "project_defect",
  });
  expect(error).toHaveBeenCalledWith("operator: Error: boom");
  expect(process.exitCode).toBe(1);
});
