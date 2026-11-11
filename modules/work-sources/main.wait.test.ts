import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { Err, Ok, OkAsync } from "unthrown";
import { DeviceState } from "../device-state/main.ts";
import { Environment } from "../environment/main.ts";
import { OperatorHome } from "../operator-home/main.ts";
import { Projects } from "../projects/main.ts";
import { WorkSources } from "./main.ts";
import { actionKey, addKeys, dropKeys } from "./coordination.ts";
import { storedSource } from "./source-fixture.ts";

const root = "/isolated/wait";
const paths = OperatorHome.resolve(Environment.parse({ HOME: root, NODE_ENV: "test" }));
afterEach(() => {
  mock.restore();
});

const ready = storedSource([{ key: "a", completion: "report", state: "ready" }]);
const pending = storedSource([
  { key: "a", completion: "report", state: "ready" },
  { key: "b", completion: "report", state: "ready", dependencies: ["a"] },
]);
const running = storedSource([{ key: "a", completion: "report", state: "running" }]);
function endedAt(at: string) {
  return storedSource([{ key: "a", completion: "report", state: "completed" }], {
    state: "finished",
    endedAt: at,
  });
}
const ended = endedAt(new Date().toISOString());
const readyKey = actionKey("one", {
  action: "ready_assignment",
  reason: "assignment_ready",
  assignment: "a",
});

function project() {
  spyOn(Projects, "current").mockReturnValue(
    OkAsync({
      reason: "project_resolved" as const,
      data: { repository: "example/one", checkout: root, registeredAt: "now" },
    }),
  );
}

function device(stored: string | null, pane: string | undefined, ...reads: (typeof ready)[][]) {
  spyOn(Environment, "read").mockReturnValue({ ...Environment.read(), HERDR_PANE_ID: pane });
  project();
  const read = spyOn(DeviceState, "readSources");
  for (const rows of reads) read.mockReturnValueOnce(Ok(rows));
  const released = mock();
  return {
    read,
    released,
    start: spyOn(DeviceState, "startCoordinationWait").mockReturnValue(Ok(stored)),
    stored: spyOn(DeviceState, "readCoordinationWait").mockReturnValue(Ok(stored)),
    change: spyOn(DeviceState, "changeCoordinationWait").mockReturnValue(Ok(stored)),
    supervision: spyOn(DeviceState, "readSupervision").mockReturnValue(
      Ok([{ id: "one", repository: "example/one", waiting: true }]),
    ),
    hold: spyOn(DeviceState, "holdCoordinationWait").mockReturnValue(released),
    finish: spyOn(DeviceState, "finishCoordinationWait").mockReturnValue(Ok(undefined)),
  };
}

/** The plain next answer for the rows. */
async function answerOf(rows: (typeof ready)[], all = true) {
  project();
  spyOn(DeviceState, "readSources").mockReturnValueOnce(Ok(rows));
  const read = await WorkSources.next({ paths, cwd: root, all });
  mock.restore();
  expect(read.tag).toBe("Ok");
  return read.tag === "Ok" ? read.value : { sources: [] };
}

/** What a finish stores over the given stored set. */
function finished(calls: ReturnType<typeof device>, over: string | null) {
  const change = calls.finish.mock.calls[0]?.[2];
  return change === undefined ? undefined : change(over);
}

test("a scope that never returned a set returns every action at once and records them", async () => {
  const calls = device(null, undefined, [ready]);
  const result = await WorkSources.wait({ paths, cwd: root, timeoutSeconds: 300 });
  expect(result).toMatchObject({
    tag: "Ok",
    value: {
      reason: "next_actions_changed",
      data: {
        sources: [
          {
            id: "one",
            repository: "example/one",
            state: "open",
            actions: [{ action: "ready_assignment", assignment: "a" }],
          },
        ],
      },
    },
  });
  const target = { repository: "example/one", scope: "" };
  expect(calls.start).toHaveBeenCalledWith(paths, target, null);
  expect(calls.hold).toHaveBeenCalledWith(paths, target);
  expect(finished(calls, null)).toBe(addKeys([readyKey])(null));
  expect(calls.released).toHaveBeenCalledTimes(1);
  expect(calls.read).toHaveBeenCalledWith(paths, "example/one", undefined);
  expect(calls.supervision).not.toHaveBeenCalled();
});

test("an unchanged set times out with no actions, or with the whole answer when asked", async () => {
  const stored = addKeys([readyKey])(null);
  const calls = device(stored, "pane-1", [ready]);
  const quiet = await WorkSources.wait({ paths, cwd: root, sourceId: "one", timeoutSeconds: 0 });
  expect(quiet).toMatchObject({
    tag: "Ok",
    value: { reason: "next_wait_timed_out", data: { sources: [] } },
  });
  expect(calls.start).toHaveBeenCalledWith(
    paths,
    { repository: "example/one", scope: "one" },
    "pane-1",
  );
  expect(calls.read).toHaveBeenCalledWith(paths, "example/one", "one");
  expect(finished(calls, stored)).toBe(stored);
  expect(calls.supervision).not.toHaveBeenCalled();
  const full = await answerOf([ready]);
  device(stored, "pane-1", [ready]);
  const board = await WorkSources.wait({
    paths,
    cwd: root,
    sourceId: "one",
    timeoutSeconds: 0,
    all: true,
  });
  expect(board).toMatchObject({
    tag: "Ok",
    value: {
      reason: "next_wait_timed_out",
      data: { sources: full.sources.map((source) => ({ ...source, repository: "example/one" })) },
    },
  });
});

test("a pane wait without a source covers the pane's sources in every project", async () => {
  const calls = device(null, "pane-1");
  calls.supervision.mockReturnValue(
    Ok([
      { id: "one", repository: "example/one", waiting: true },
      { id: "one", repository: "example/two", waiting: true },
    ]),
  );
  calls.read.mockReturnValueOnce(Ok([ready])).mockReturnValueOnce(Ok([pending]));
  const result = await WorkSources.wait({ paths, cwd: root, timeoutSeconds: 300 });
  const target = { repository: "example/one", scope: "pane:pane-1" };
  expect(calls.start).toHaveBeenCalledWith(paths, target, "pane-1");
  expect(calls.supervision).toHaveBeenCalledWith(paths, "pane-1");
  expect(calls.read).toHaveBeenCalledWith(paths, "example/one", undefined);
  expect(calls.read).toHaveBeenCalledWith(paths, "example/two", undefined);
  expect(result).toMatchObject({
    tag: "Ok",
    value: {
      data: {
        sources: [
          { id: "one", repository: "example/one" },
          { id: "one", repository: "example/two" },
        ],
      },
    },
  });
});

test("an action that appears during the wait returns alone from its second read", async () => {
  const stored = addKeys([])(null);
  const calls = device(stored, undefined, [running], [ready], [ready]);
  const started = Date.now();
  const result = await WorkSources.wait({ paths, cwd: root, timeoutSeconds: 60 });
  expect(result).toMatchObject({
    tag: "Ok",
    value: {
      reason: "next_actions_changed",
      data: { sources: [{ id: "one", actions: [{ action: "ready_assignment" }] }] },
    },
  });
  expect(result.tag === "Ok" && "waits" in (result.value.data.sources[0] ?? {})).toBe(false);
  expect(Date.now() - started).toBeLessThan(30000);
  expect(calls.read).toHaveBeenCalledTimes(3);
  expect(finished(calls, stored)).toBe(addKeys([readyKey])(null));
}, 30000);

test("an action that the pane acknowledged during the wait never returns", async () => {
  const empty = addKeys([])(null);
  const calls = device(empty, undefined, [running], [ready], [ready]);
  calls.stored
    .mockReturnValueOnce(Ok(empty))
    .mockReturnValueOnce(Ok(empty))
    .mockReturnValue(Ok(addKeys([readyKey])(null)));
  calls.read.mockReturnValue(Ok([ready]));
  const result = await WorkSources.wait({ paths, cwd: root, timeoutSeconds: 5 });
  expect(result).toMatchObject({
    tag: "Ok",
    value: { reason: "next_wait_timed_out", data: { sources: [] } },
  });
}, 30000);

test("a removed action leaves the stored set and wakes nobody", async () => {
  const stored = addKeys([readyKey])(null);
  const calls = device(stored, undefined, [running]);
  const result = await WorkSources.wait({ paths, cwd: root, timeoutSeconds: 0 });
  expect(result).toMatchObject({ tag: "Ok", value: { reason: "next_wait_timed_out" } });
  const change = calls.change.mock.calls[0]?.[2];
  expect(change?.(stored)).toBe(dropKeys([readyKey])(stored));
});

test("a refused read ends the wait with its refusal and releases the lease", async () => {
  const calls = device(null, undefined);
  calls.read.mockReturnValueOnce(Err({ reason: "state_busy" as const, detail: "busy" }));
  expect(await WorkSources.wait({ paths, cwd: root, timeoutSeconds: 300 })).toMatchObject({
    tag: "Err",
    error: { reason: "state_busy", detail: "busy" },
  });
  expect(calls.finish).not.toHaveBeenCalled();
  expect(calls.released).toHaveBeenCalledTimes(1);
});

test("a refused start records nothing and holds no lease", async () => {
  const calls = device(null, undefined);
  calls.start.mockReturnValue(Err({ reason: "state_busy" as const, detail: "busy" }));
  expect(await WorkSources.wait({ paths, cwd: root, timeoutSeconds: 300 })).toMatchObject({
    tag: "Err",
    error: { reason: "state_busy" },
  });
  expect(calls.hold).not.toHaveBeenCalled();
  expect(calls.read).not.toHaveBeenCalled();
});

test("next leaves out a source's end unless asked for the whole board", async () => {
  expect(await answerOf([ended], false)).toEqual({ sources: [] });
  const full = await answerOf([ended], true);
  expect(full.sources[0]?.actions).toMatchObject([{ action: "source_ended", reason: "finished" }]);
  // A source past its retention keeps its prune row.
  expect(await answerOf([endedAt("2026-01-02T00:00:00.000Z")], false)).toMatchObject({
    sources: [{ id: "one", actions: [{ action: "prune_source" }] }],
  });
});

function acknowledged(before: (typeof ready)[], after: (typeof ready)[]) {
  project();
  spyOn(DeviceState, "readSources").mockReturnValueOnce(Ok(before)).mockReturnValueOnce(Ok(after));
  return spyOn(DeviceState, "acknowledgeCoordinationWaits").mockReturnValue(Ok(undefined));
}

test("a pane command acknowledges the actions that it added to its source", async () => {
  const acknowledge = acknowledged([running], [ready]);
  const change = mock(async () => "done");
  expect(
    await WorkSources.acknowledgeOwnChange(
      { paths, cwd: root, paneId: "pane-1", sourceId: "one", assignment: "a" },
      change,
    ),
  ).toBe("done");
  expect(change).toHaveBeenCalledTimes(1);
  expect(acknowledge).toHaveBeenCalledWith(paths, "pane-1", expect.any(Function));
  expect(acknowledge.mock.calls[0]?.[2](null)).toBe(addKeys([readyKey])(null));
});

test("a pane command acknowledges nothing for another assignment, another source, or no change", async () => {
  for (const selector of [
    { sourceId: "one", assignment: "b" },
    { sourceId: "two" },
    { sourceId: undefined },
  ]) {
    const acknowledge = acknowledged([running], [ready]);
    await WorkSources.acknowledgeOwnChange(
      { paths, cwd: root, paneId: "pane-1", ...selector },
      async () => undefined,
    );
    expect(acknowledge).not.toHaveBeenCalled();
    mock.restore();
  }
  const acknowledge = acknowledged([ready], [ready]);
  await WorkSources.acknowledgeOwnChange(
    { paths, cwd: root, paneId: "pane-1", sourceId: "one" },
    async () => undefined,
  );
  expect(acknowledge).not.toHaveBeenCalled();
});

test("a registration acknowledges the actions of its new source", async () => {
  const acknowledge = acknowledged([], [ready]);
  await WorkSources.acknowledgeOwnChange(
    { paths, cwd: root, paneId: "pane-1" },
    async () => undefined,
  );
  expect(acknowledge.mock.calls[0]?.[2](null)).toBe(addKeys([readyKey])(null));
});

test("a failed read runs the command and acknowledges nothing", async () => {
  project();
  spyOn(DeviceState, "readSources").mockReturnValue(
    Err({ reason: "state_busy" as const, detail: "busy" }),
  );
  const acknowledge = spyOn(DeviceState, "acknowledgeCoordinationWaits");
  expect(
    await WorkSources.acknowledgeOwnChange(
      { paths, cwd: root, paneId: "pane-1" },
      async () => "done",
    ),
  ).toBe("done");
  expect(acknowledge).not.toHaveBeenCalled();
});

function supervised(...sources: { id: string; waiting: boolean }[]) {
  return spyOn(DeviceState, "readSupervision").mockReturnValue(
    Ok(sources.map((source) => ({ ...source, repository: "example/one" }))),
  );
}

test("a supervised source with running work and no wait from the pane is unwatched", async () => {
  const read = supervised({ id: "one", waiting: false });
  const rows = spyOn(DeviceState, "readSources").mockReturnValue(Ok([running]));
  expect(await WorkSources.unwatched({ paths, cwd: root, paneId: "pane-1" })).toMatchObject({
    tag: "Ok",
    value: ["one"],
  });
  expect(read).toHaveBeenCalledWith(paths, "pane-1");
  expect(rows).toHaveBeenCalledWith(paths, "example/one", "one");
});

test("a covered source, work that waits only for dependencies, or no running work is watched", async () => {
  supervised({ id: "one", waiting: true }, { id: "two", waiting: false });
  const rows = spyOn(DeviceState, "readSources");
  for (const answer of [[ready], [pending], []]) {
    rows.mockReturnValueOnce(Ok(answer));
    expect(await WorkSources.unwatched({ paths, cwd: root, paneId: "pane-1" })).toMatchObject({
      tag: "Ok",
      value: [],
    });
  }
  // A covered source is not read at all.
  expect(rows).toHaveBeenCalledTimes(3);
  expect(rows).not.toHaveBeenCalledWith(paths, "example/one", "one");
});

test("a supervision read failure is the unwatched read's failure", async () => {
  const failure = { reason: "state_missing" as const, detail: "missing" };
  spyOn(DeviceState, "readSupervision").mockReturnValue(Err(failure));
  expect(await WorkSources.unwatched({ paths, cwd: root, paneId: "pane-1" })).toMatchObject({
    tag: "Err",
    error: failure,
  });
});
