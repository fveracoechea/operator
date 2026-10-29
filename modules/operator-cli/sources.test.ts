import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { ErrAsync, fromSafePromise, OkAsync } from "unthrown";
import { Environment } from "../environment/main.ts";
import { OperatorHome } from "../operator-home/main.ts";
import { WorkSources } from "../work-sources/main.ts";
import { runSources, sourceArgs } from "./sources.ts";

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

function spies() {
  return {
    register: spyOn(WorkSources, "register").mockReturnValue(OkAsync({ id: "r" }) as never),
    show: spyOn(WorkSources, "show").mockReturnValue(OkAsync({ id: "s" }) as never),
    reset: spyOn(WorkSources, "reset").mockReturnValue(OkAsync({ id: "x" }) as never),
    prune: spyOn(WorkSources, "prune").mockReturnValue(OkAsync({ id: "p" }) as never),
    next: spyOn(WorkSources, "next").mockReturnValue(OkAsync({ id: "n" }) as never),
  };
}

test("parses only the delivered source and next commands", () => {
  expect(sourceArgs(["source", "register", "--file", "plan.json", "--json"])).toEqual({
    operation: "register",
    file: "plan.json",
    sourceId: undefined,
    personInstructed: false,
  });
  expect(sourceArgs(["source", "show", "--source", "id"])).toEqual({
    operation: "show",
    file: undefined,
    sourceId: "id",
    personInstructed: false,
  });
  expect(sourceArgs(["next", "--source", "id", "--json"])).toEqual({
    operation: "next",
    file: undefined,
    sourceId: "id",
    personInstructed: false,
  });
  expect(sourceArgs(["next"])).toEqual({
    operation: "next",
    file: undefined,
    sourceId: undefined,
    personInstructed: false,
  });
  expect(sourceArgs(["source", "reset", "--person-instructed", "--source", "id"])).toEqual({
    operation: "reset",
    file: undefined,
    sourceId: "id",
    personInstructed: true,
  });
  // A missing instruction is parsed, so the operation refuses with its own reason.
  expect(sourceArgs(["source", "reset", "--source", "id"])).toMatchObject({
    operation: "reset",
    personInstructed: false,
  });
  expect(sourceArgs(["source", "prune", "--json"])).toEqual({
    operation: "prune",
    file: undefined,
    sourceId: undefined,
    personInstructed: false,
  });
});
test.each(
  [
    ["source"],
    ["source", "register"],
    ["source", "show"],
    ["source", "register", "--file"],
    ["source", "register", "--file", "--json"],
    ["source", "register", "--file", "a", "--file", "b"],
    ["source", "register", "--source", "id"],
    ["source", "register", "--file", "a", "--person-instructed"],
    ["next", "--json", "--json"],
    ["next", "--unknown"],
    ["next", "--person-instructed"],
    ["source", "reset"],
    ["source", "reset", "--person-instructed"],
    ["source", "reset", "--source", "id", "--person-instructed", "--person-instructed"],
    ["source", "prune", "--source", "id"],
    ["source", "prune", "--person-instructed"],
    ["source", "archive"],
    ["dispatch"],
    ["other", "show", "--source", "id"],
    ["other", "register", "--file", "plan.json"],
  ].map((args) => ({ args })),
)("refuses invalid arguments $args", ({ args }) => {
  expect(sourceArgs(args)).toBeNull();
});

test("refuses invalid source commands before any source operation", async () => {
  const called = spies();
  for (const args of [["source"], ["source", "show"], ["next", "--unknown"], ["other"]])
    expect(await runSources(args, paths, true)).toBe(false);
  for (const spy of Object.values(called)) expect(spy).not.toHaveBeenCalled();
});

test("passes each command to the matching source operation and names its result", async () => {
  const called = spies();
  const { log } = quiet();
  const cwd = process.cwd();
  await runSources(["source", "register", "--file", "plan.json"], paths, true);
  expect(called.register).toHaveBeenCalledWith({ paths, cwd, file: "plan.json" });
  expect(JSON.parse(String(log.mock.lastCall?.[0]))).toMatchObject({
    operation: "source_register",
    reason: "source_registered",
    data: { id: "r" },
  });
  await runSources(["source", "show", "--source", "s1"], paths, true);
  expect(called.show).toHaveBeenCalledWith({ paths, cwd, sourceId: "s1" });
  expect(JSON.parse(String(log.mock.lastCall?.[0]))).toMatchObject({
    operation: "source_show",
    reason: "source_read",
  });
  await runSources(["source", "reset", "--source", "s2", "--person-instructed"], paths, true);
  expect(called.reset).toHaveBeenCalledWith({
    paths,
    cwd,
    sourceId: "s2",
    personInstructed: true,
  });
  expect(JSON.parse(String(log.mock.lastCall?.[0]))).toMatchObject({
    operation: "source_reset",
    reason: "source_reset",
  });
  await runSources(["source", "prune"], paths, true);
  expect(called.prune).toHaveBeenCalledWith({ paths, cwd });
  expect(JSON.parse(String(log.mock.lastCall?.[0]))).toMatchObject({
    operation: "source_prune",
    reason: "sources_pruned",
  });
  await runSources(["next", "--source", "s3"], paths, true);
  expect(called.next).toHaveBeenLastCalledWith({ paths, cwd, sourceId: "s3" });
  expect(JSON.parse(String(log.mock.lastCall?.[0]))).toMatchObject({
    operation: "next",
    reason: "next_actions_read",
  });
  await runSources(["next"], paths, true);
  expect(called.next).toHaveBeenLastCalledWith({ paths, cwd, sourceId: undefined });
  for (const name of ["register", "show", "reset", "prune"] as const)
    expect(called[name]).toHaveBeenCalledTimes(1);
  expect(called.next).toHaveBeenCalledTimes(2);
});

test("prints a completed operation as compact JSON or as indented text", async () => {
  spies();
  const { log } = quiet();
  const expected = {
    schemaVersion: 1,
    operation: "source_show",
    outcome: "completed",
    reason: "source_read",
    blockers: [],
    data: { id: "s" },
  };
  process.exitCode = 7;
  expect(await runSources(["source", "show", "--source", "s"], paths, true)).toBe(true);
  expect(log).toHaveBeenLastCalledWith(JSON.stringify(expected));
  expect(process.exitCode).toBe(0);
  expect(await runSources(["source", "show", "--source", "s"], paths, false)).toBe(true);
  expect(log).toHaveBeenLastCalledWith(JSON.stringify(expected, null, 2));
});

test.each([
  ["invalid_source_plan", 2],
  ["source_parent_open", 4],
  ["controller_mismatch", 4],
  ["controller_identity_mismatch", 4],
  ["state_busy", 1],
  ["state_io_failed", 1],
  ["source_io_failed", 1],
  ["source_prune_failed", 1],
  ["project_io_failed", 1],
  ["settings_io_failed", 1],
  ["source_not_found", 3],
])("refuses %s with exit code %d", async (reason, code) => {
  spyOn(WorkSources, "prune").mockReturnValue(ErrAsync({ reason, detail: "not pruned" }) as never);
  const { log, error } = quiet();
  expect(await runSources(["source", "prune"], paths, true)).toBe(true);
  expect(JSON.parse(String(log.mock.lastCall?.[0]))).toMatchObject({
    operation: "source_prune",
    reason,
  });
  expect(error).toHaveBeenCalledWith("operator: not pruned");
  expect(process.exitCode).toBe(code);
});

test("reports a source defect with exit code 1", async () => {
  spyOn(WorkSources, "next").mockReturnValue(
    fromSafePromise(() => Promise.reject(new Error("boom"))) as never,
  );
  const { log, error } = quiet();
  expect(await runSources(["next"], paths, true)).toBe(true);
  expect(JSON.parse(String(log.mock.lastCall?.[0]))).toMatchObject({
    operation: "next",
    reason: "source_defect",
  });
  expect(error).toHaveBeenCalledWith("operator: Error: boom");
  expect(process.exitCode).toBe(1);
});
