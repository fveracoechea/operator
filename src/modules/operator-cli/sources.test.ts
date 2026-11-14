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
    takeOver: spyOn(WorkSources, "takeOver").mockReturnValue(OkAsync({ id: "t" }) as never),
    prune: spyOn(WorkSources, "prune").mockReturnValue(OkAsync({ id: "p" }) as never),
    next: spyOn(WorkSources, "next").mockReturnValue(OkAsync({ id: "n" }) as never),
    wait: spyOn(WorkSources, "wait").mockReturnValue(
      OkAsync({ reason: "next_wait_timed_out", data: { sources: [] } }) as never,
    ),
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
    sourceId: "id",
    personInstructed: false,
    all: false,
  });
  expect(sourceArgs(["next", "--all"])).toEqual({
    operation: "next",
    sourceId: undefined,
    personInstructed: false,
    all: true,
  });
  expect(sourceArgs(["next", "--wait", "--json"])).toEqual({
    operation: "next_wait",
    sourceId: undefined,
    personInstructed: false,
    timeoutSeconds: 300,
    all: false,
  });
  expect(sourceArgs(["next", "--timeout", "0", "--all", "--source", "id", "--wait"])).toEqual({
    operation: "next_wait",
    sourceId: "id",
    personInstructed: false,
    timeoutSeconds: 0,
    all: true,
  });
  expect(sourceArgs(["next", "--wait", "--timeout", "99999"])).toMatchObject({
    timeoutSeconds: 99999,
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
    ["next", "--wait", "--wait"],
    ["next", "--all", "--all"],
    ["source", "show", "--source", "id", "--all"],
    ["source", "prune", "--all"],
    ["next", "--timeout", "10"],
    ["next", "--wait", "--timeout"],
    ["next", "--wait", "--timeout", "--json"],
    ["next", "--wait", "--timeout", "-1"],
    ["next", "--wait", "--timeout", "1.5"],
    ["next", "--wait", "--timeout", "100000"],
    ["next", "--wait", "--timeout", "1", "--timeout", "2"],
    ["source", "show", "--source", "id", "--wait"],
    ["source", "prune", "--timeout", "1"],
    ["source", "reset"],
    ["source", "reset", "--person-instructed"],
    ["source", "reset", "--source", "id", "--person-instructed", "--person-instructed"],
    ["source", "prune", "--source", "id"],
    ["source", "prune", "--person-instructed"],
    ["source", "take-over"],
    ["source", "take-over", "--person-instructed"],
    ["source", "take-over", "--file", "a"],
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
  await runSources(["source", "take-over", "--source", "s5", "--person-instructed"], paths, true);
  expect(called.takeOver).toHaveBeenCalledWith({
    paths,
    cwd,
    sourceId: "s5",
    personInstructed: true,
  });
  expect(JSON.parse(String(log.mock.lastCall?.[0]))).toMatchObject({
    operation: "source_take_over",
    reason: "source_taken_over",
  });
  await runSources(["source", "take-over", "--source", "s5"], paths, true);
  expect(called.takeOver).toHaveBeenLastCalledWith({
    paths,
    cwd,
    sourceId: "s5",
    personInstructed: false,
  });
  await runSources(["source", "prune"], paths, true);
  expect(called.prune).toHaveBeenCalledWith({ paths, cwd });
  expect(JSON.parse(String(log.mock.lastCall?.[0]))).toMatchObject({
    operation: "source_prune",
    reason: "sources_pruned",
  });
  await runSources(["next", "--source", "s3"], paths, true);
  expect(called.next).toHaveBeenLastCalledWith({ paths, cwd, sourceId: "s3", all: false });
  expect(JSON.parse(String(log.mock.lastCall?.[0]))).toMatchObject({
    operation: "next",
    reason: "next_actions_read",
  });
  await runSources(["next", "--all"], paths, true);
  expect(called.next).toHaveBeenLastCalledWith({ paths, cwd, sourceId: undefined, all: true });
  for (const name of ["register", "show", "reset", "prune"] as const)
    expect(called[name]).toHaveBeenCalledTimes(1);
  expect(called.takeOver).toHaveBeenCalledTimes(2);
  expect(called.next).toHaveBeenCalledTimes(2);
  expect(called.wait).not.toHaveBeenCalled();
});

test("passes a wait to the coordination wait, which names its own result", async () => {
  const called = spies();
  const { log, error } = quiet();
  const cwd = process.cwd();
  await runSources(["next", "--wait", "--source", "s4", "--timeout", "12"], paths, true);
  expect(called.wait).toHaveBeenCalledWith({
    paths,
    cwd,
    sourceId: "s4",
    timeoutSeconds: 12,
    all: false,
  });
  expect(JSON.parse(String(log.mock.lastCall?.[0]))).toEqual({
    schemaVersion: 1,
    operation: "next_wait",
    outcome: "completed",
    reason: "next_wait_timed_out",
    blockers: [],
    data: { sources: [] },
    next: { why: "No next actions to report." },
  });
  called.wait.mockReturnValue(ErrAsync({ reason: "state_busy", detail: "busy" }) as never);
  await runSources(["next", "--wait", "--all"], paths, true);
  expect(called.wait).toHaveBeenLastCalledWith({
    paths,
    cwd,
    sourceId: undefined,
    timeoutSeconds: 300,
    all: true,
  });
  expect(JSON.parse(String(log.mock.lastCall?.[0]))).toMatchObject({
    operation: "next_wait",
    reason: "state_busy",
  });
  expect(error).toHaveBeenCalledWith("operator: busy");
  expect(process.exitCode).toBe(1);
  expect(called.next).not.toHaveBeenCalled();
});

test("an absent source result keeps its empty success without next-action metadata", async () => {
  const { log, error } = quiet();
  spyOn(WorkSources, "show").mockReturnValue(OkAsync(undefined));
  await runSources(["source", "show", "--source", "missing"], paths, true);
  expect(JSON.parse(String(log.mock.lastCall?.[0]))).toStrictEqual({
    schemaVersion: 1,
    operation: "source_show",
    outcome: "completed",
    reason: "source_read",
    blockers: [],
  });
  expect(error).not.toHaveBeenCalled();
  expect(process.exitCode).toBe(0);
});

test("next decorates nonempty actions and waits without losing source facts", async () => {
  const { log, error } = quiet();
  spyOn(WorkSources, "next").mockReturnValue(
    OkAsync({
      sources: [
        {
          id: "source",
          state: "open",
          repository: "example/one",
          actions: [
            {
              assignment: "read",
              action: "ready_assignment",
              reason: "assignment_ready",
              blockers: [],
            },
          ],
          waits: [
            { assignment: "write", action: "wait", reason: "dependencies_pending", blockers: [] },
          ],
          owed: [],
        },
      ],
    }),
  );
  await runSources(["next"], paths, true);
  expect(JSON.parse(String(log.mock.lastCall?.[0]))).toStrictEqual({
    schemaVersion: 1,
    operation: "next",
    outcome: "completed",
    reason: "next_actions_read",
    blockers: [],
    next: { why: "Follow the next step on the applicable row." },
    data: {
      sources: [
        {
          id: "source",
          state: "open",
          repository: "example/one",
          actions: [
            {
              assignment: "read",
              action: "ready_assignment",
              reason: "assignment_ready",
              blockers: [],
              command: "operator dispatch --source source --assignment read",
              next: {
                command: "operator dispatch --source source --assignment read",
                why: "The assignment is ready to start.",
              },
            },
          ],
          waits: [
            {
              assignment: "write",
              action: "wait",
              reason: "dependencies_pending",
              blockers: [],
              command: "operator next --source source --wait",
              next: {
                command: "operator next --source source --wait",
                why: "Wait for the recorded blockers to change.",
              },
            },
          ],
          owed: [],
        },
      ],
    },
  });
  expect(error).not.toHaveBeenCalled();
  expect(process.exitCode).toBe(0);
});

test("a coordination change decorates actions without adding an absent waits field", async () => {
  const { log, error } = quiet();
  spyOn(WorkSources, "wait").mockReturnValue(
    OkAsync({
      reason: "next_actions_changed",
      data: {
        sources: [
          {
            id: "source",
            state: "finished",
            repository: "example/one",
            actions: [{ action: "prune_source", reason: "retention_elapsed" }],
          },
        ],
      },
    }),
  );
  await runSources(["next", "--wait"], paths, true);
  expect(JSON.parse(String(log.mock.lastCall?.[0]))).toStrictEqual({
    schemaVersion: 1,
    operation: "next_wait",
    outcome: "completed",
    reason: "next_actions_changed",
    blockers: [],
    next: { why: "Follow the next step on the applicable row." },
    data: {
      sources: [
        {
          id: "source",
          state: "finished",
          repository: "example/one",
          actions: [
            {
              action: "prune_source",
              reason: "retention_elapsed",
              command: "operator source prune",
              next: {
                command: "operator source prune",
                why: "The source retention period has elapsed.",
              },
            },
          ],
        },
      ],
    },
  });
  expect(error).not.toHaveBeenCalled();
  expect(process.exitCode).toBe(0);
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
