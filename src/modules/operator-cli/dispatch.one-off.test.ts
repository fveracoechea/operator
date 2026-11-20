import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { ErrAsync, fromSafePromise, OkAsync } from "unthrown";
import { Environment } from "../environment/main.ts";
import { OperatorHome } from "../operator-home/main.ts";
import { WorkerDispatch } from "../worker-dispatch/main.ts";
import { WorkSources } from "../work-sources/main.ts";
import { dispatchArgs, dispatchRegistered, runDispatch } from "./dispatch.ts";

const paths = OperatorHome.resolve(
  Environment.parse({
    HOME: "/isolated",
    XDG_CONFIG_HOME: "/isolated/config",
    XDG_STATE_HOME: "/isolated/state",
  }),
);
const source = { id: "source-1", assignments: [{ key: "read-queue" }, { key: "later" }] };

afterEach(() => {
  mock.restore();
  process.exitCode = 0;
});

test("parses one-off input without interpreting file contents or kind policy", () => {
  expect(dispatchArgs(["dispatch", "--kind", "answer", "--brief", "-"])).toEqual({
    operation: "one_off_dispatch",
    kind: "answer",
    brief: "-",
    intentFile: undefined,
    profile: undefined,
    trackerKey: undefined,
  });
  expect(
    dispatchArgs([
      "dispatch",
      "--json",
      "--profile",
      "careful",
      "--brief",
      "task.md",
      "--tracker-key",
      "github:example/one#42",
      "--kind",
      "custom",
      "--intent-file",
      "intent.txt",
    ]),
  ).toEqual({
    operation: "one_off_dispatch",
    kind: "custom",
    brief: "task.md",
    intentFile: "intent.txt",
    profile: "careful",
    trackerKey: "github:example/one#42",
  });
});

test.each([
  [["abandon", "--kind", "answer", "--brief", "-"]],
  [["dispatch", "--kind", "answer"]],
  [["dispatch", "--brief", "-"]],
  [["dispatch", "--kind", "answer", "--brief", "-", "--source", "s"]],
  [["dispatch", "--kind", "answer", "--brief", "-", "--assignment", "a"]],
  [["dispatch", "--kind", "answer", "--brief", "-", "--kind", "research"]],
  [["dispatch", "--kind", "answer", "--brief", "-", "--brief", "task.md"]],
  [["dispatch", "--kind", "answer", "--brief", "-", "--completion", "pr"]],
  [["dispatch", "--kind", "answer", "--brief", "-", "--intent", "inline"]],
  [["dispatch", "--kind", "answer", "--brief", "-", "--profile"]],
  [["dispatch", "--kind", "--brief", "-"]],
  [["dispatch", "--kind", "answer", "--brief", "-", "--json", "--json"]],
  [["dispatch", "--source", "s", "--assignment", "a", "--profile", "careful"]],
  [["dispatch", "--source", "s", "--assignment", "a", "--intent-file", "intent.txt"]],
  [["dispatch", "--source", "s", "--assignment", "a", "--tracker-key", "issue:42"]],
])("refuses mixed or incomplete one-off arguments %j without effects", async (args) => {
  const register = spyOn(WorkSources, "oneOff").mockReturnValue(OkAsync(source) as never);
  const dispatch = spyOn(WorkerDispatch, "dispatch").mockReturnValue(OkAsync({}) as never);
  const abandon = spyOn(WorkSources, "abandon").mockReturnValue(OkAsync({}) as never);
  const log = spyOn(console, "log").mockImplementation(() => {});
  expect(dispatchArgs(args)).toBeNull();
  expect(await runDispatch(args, paths, true)).toBe(false);
  expect(register).not.toHaveBeenCalled();
  expect(dispatch).not.toHaveBeenCalled();
  expect(abandon).not.toHaveBeenCalled();
  expect(log).not.toHaveBeenCalled();
});

test.each([true, false])(
  "registers before launching and reports the launch with json=%s",
  async (json) => {
    const register = spyOn(WorkSources, "oneOff").mockReturnValue(OkAsync(source) as never);
    const data = { sourceId: "source-1", assignment: "read-queue", paneId: "pane-1" };
    const dispatch = spyOn(WorkerDispatch, "dispatch").mockImplementation(() => {
      expect(register).toHaveBeenCalledTimes(1);
      return OkAsync(data) as never;
    });
    const log = spyOn(console, "log").mockImplementation(() => {});
    process.exitCode = 7;
    expect(
      await runDispatch(
        [
          "dispatch",
          "--kind",
          "answer",
          "--brief",
          "task.md",
          "--intent-file",
          "-",
          "--profile",
          "careful",
          "--tracker-key",
          "issue:42",
        ],
        paths,
        json,
      ),
    ).toBe(true);
    expect(register).toHaveBeenCalledWith({
      paths,
      cwd: process.cwd(),
      operation: "one_off_dispatch",
      kind: "answer",
      brief: "task.md",
      intentFile: "-",
      profile: "careful",
      trackerKey: "issue:42",
    });
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch).toHaveBeenCalledWith({
      paths,
      cwd: process.cwd(),
      sourceId: "source-1",
      assignment: "read-queue",
    });
    expect(log).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith(
      JSON.stringify(
        {
          schemaVersion: 1,
          operation: "dispatch",
          outcome: "completed",
          reason: "worker_launched",
          blockers: [],
          data,
        },
        null,
        json ? undefined : 2,
      ),
    );
    expect(process.exitCode).toBe(0);
  },
);

test.each([
  ["invalid_source_plan", 2],
  ["source_profile_missing", 3],
  ["source_parent_open", 4],
  ["source_io_failed", 1],
  ["kind_not_dispatchable", 4],
])("registration refusal %s exits %d without launching", async (reason, code) => {
  const refusal = {
    reason,
    detail: "Cannot register.",
    next: { command: "operator next", why: "Inspect the source." },
    state: { checked: true },
  };
  spyOn(WorkSources, "oneOff").mockReturnValue(ErrAsync(refusal) as never);
  const dispatch = spyOn(WorkerDispatch, "dispatch").mockReturnValue(OkAsync({}) as never);
  const log = spyOn(console, "log").mockImplementation(() => {});
  spyOn(console, "error").mockImplementation(() => {});
  expect(await runDispatch(["dispatch", "--kind", "answer", "--brief", "-"], paths, true)).toBe(
    true,
  );
  expect(dispatch).not.toHaveBeenCalled();
  expect(JSON.parse(String(log.mock.lastCall?.[0]))).toMatchObject({
    operation: "dispatch",
    reason,
    blockers: [{ reason, detail: "Cannot register." }],
    next: refusal.next,
    state: refusal.state,
  });
  expect(process.exitCode).toBe(code);
});

test("a failed one-off launch keeps the dispatch owner's facts and names the registered task retry", async () => {
  spyOn(WorkSources, "oneOff").mockReturnValue(OkAsync(source) as never);
  const refusal = {
    reason: "herdr_failed",
    detail: "Plugin unavailable.",
    next: { decider: "super-agent", question: "Inspect the failed command?" },
    state: { exitCode: 1 },
  };
  spyOn(WorkerDispatch, "dispatch").mockReturnValue(ErrAsync(refusal) as never);
  const log = spyOn(console, "log").mockImplementation(() => {});
  const error = spyOn(console, "error").mockImplementation(() => {});
  expect(await runDispatch(["dispatch", "--kind", "answer", "--brief", "-"], paths, true)).toBe(
    true,
  );
  expect(JSON.parse(String(log.mock.lastCall?.[0]))).toMatchObject({
    operation: "dispatch",
    reason: "herdr_failed",
    next: refusal.next,
    state: refusal.state,
    blockers: [
      {
        reason: "herdr_failed",
        detail:
          "Plugin unavailable. Source source-1 holds the task. Run operator dispatch --source source-1 --assignment read-queue again.",
      },
    ],
  });
  expect(error).toHaveBeenCalledWith(
    "operator: herdr_failed: Plugin unavailable. Source source-1 holds the task. Run operator dispatch --source source-1 --assignment read-queue again.",
  );
  expect(process.exitCode).toBe(1);
});

test("registered dispatch passes a defect through without inventing a launch refusal", async () => {
  const cause = new Error("launch defect");
  spyOn(WorkerDispatch, "dispatch").mockReturnValue(fromSafePromise(() => Promise.reject(cause)));
  expect(await dispatchRegistered({ paths, cwd: "/project" }, source, "task")).toMatchObject({
    tag: "Defect",
    cause,
  });
});

test("one-off registration defects use the dispatch defect result without launching", async () => {
  spyOn(WorkSources, "oneOff").mockReturnValue(
    fromSafePromise(() => Promise.reject(new Error("registration defect"))),
  );
  const dispatch = spyOn(WorkerDispatch, "dispatch").mockReturnValue(OkAsync({}) as never);
  const log = spyOn(console, "log").mockImplementation(() => {});
  spyOn(console, "error").mockImplementation(() => {});
  expect(await runDispatch(["dispatch", "--kind", "answer", "--brief", "-"], paths, true)).toBe(
    true,
  );
  expect(dispatch).not.toHaveBeenCalled();
  expect(JSON.parse(String(log.mock.lastCall?.[0]))).toMatchObject({
    operation: "dispatch",
    reason: "dispatch_defect",
    blockers: [{ reason: "dispatch_defect", detail: "Error: registration defect" }],
  });
  expect(process.exitCode).toBe(1);
});

test("registered dispatch without assignments leaves the empty selector for the dispatch owner", async () => {
  const dispatch = spyOn(WorkerDispatch, "dispatch").mockReturnValue(
    OkAsync({ paneId: "pane-1" }) as never,
  );
  expect(
    await dispatchRegistered({ paths, cwd: "/project" }, { id: "empty", assignments: [] }, "task"),
  ).toMatchObject({ tag: "Ok", value: { paneId: "pane-1" } });
  expect(dispatch).toHaveBeenCalledWith({
    paths,
    cwd: "/project",
    sourceId: "empty",
    assignment: "",
  });
});
