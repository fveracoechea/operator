import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { Err, Ok, OkAsync } from "unthrown";
import { DeviceState } from "../device-state/main.ts";
import { Environment } from "../environment/main.ts";
import { OperatorHome } from "../operator-home/main.ts";
import { Projects } from "../projects/main.ts";
import { WorkSources } from "./main.ts";
import { actionSet } from "./coordination.ts";
import { storedSource } from "./source-fixture.ts";

const root = "/isolated/wait";
const paths = OperatorHome.resolve(Environment.parse({ HOME: root, NODE_ENV: "test" }));
afterEach(() => {
  mock.restore();
});

const ready = storedSource([{ key: "a", completion: "report", state: "ready" }]);
const running = storedSource([{ key: "a", completion: "report", state: "running" }]);

function project() {
  spyOn(Projects, "current").mockReturnValue(
    OkAsync({
      reason: "project_resolved" as const,
      data: { repository: "example/one", checkout: root, registeredAt: "now" },
    }),
  );
}

const supervisor = { pane: "pane-1", session: "ses-1" };

function device(returned: string | null, ...reads: (typeof ready)[][]) {
  spyOn(Environment, "read").mockReturnValue({
    ...Environment.read(),
    HERDR_PANE_ID: "pane-1",
    OPENCODE_SESSION_ID: "ses-1",
  });
  project();
  const read = spyOn(DeviceState, "readSources");
  for (const rows of reads) read.mockReturnValueOnce(Ok(rows));
  const released = mock();
  return {
    read,
    released,
    start: spyOn(DeviceState, "startCoordinationWait").mockReturnValue(Ok(returned)),
    hold: spyOn(DeviceState, "holdCoordinationWait").mockReturnValue(released),
    finish: spyOn(DeviceState, "finishCoordinationWait").mockReturnValue(Ok(undefined)),
  };
}

/** The plain next answer for the rows, which a wait must return unchanged. */
async function answerOf(rows: (typeof ready)[]) {
  project();
  spyOn(DeviceState, "readSources").mockReturnValueOnce(Ok(rows));
  const read = await WorkSources.next({ paths, cwd: root });
  mock.restore();
  expect(read.tag).toBe("Ok");
  return read.tag === "Ok" ? read.value : { sources: [] };
}

test("a scope that never returned a set returns the normal next answer at once and records its set", async () => {
  const expected = await answerOf([ready]);
  const calls = device(null, [ready]);
  const result = await WorkSources.wait({ paths, cwd: root, timeoutSeconds: 300 });
  expect(result).toMatchObject({
    tag: "Ok",
    value: { reason: "next_actions_changed", data: expected },
  });
  const target = { repository: "example/one", scope: "" };
  expect(calls.start).toHaveBeenCalledWith(paths, target, supervisor);
  expect(calls.hold).toHaveBeenCalledWith(paths, target);
  expect(calls.finish).toHaveBeenCalledWith(paths, target, actionSet(expected));
  expect(calls.released).toHaveBeenCalledTimes(1);
  expect(calls.read).toHaveBeenCalledWith(paths, "example/one", undefined);
});

test("an unchanged set waits until the timeout and returns the unchanged answer", async () => {
  const expected = await answerOf([ready]);
  const calls = device(actionSet(expected), [ready]);
  const result = await WorkSources.wait({
    paths,
    cwd: root,
    sourceId: "one",
    timeoutSeconds: 0,
  });
  expect(result).toMatchObject({
    tag: "Ok",
    value: { reason: "next_wait_timed_out", data: expected },
  });
  expect(calls.start).toHaveBeenCalledWith(
    paths,
    { repository: "example/one", scope: "one" },
    supervisor,
  );
  expect(calls.read).toHaveBeenCalledWith(paths, "example/one", "one");
  expect(calls.released).toHaveBeenCalledTimes(1);
});

test("a change during the wait returns the new answer before the timeout", async () => {
  const before = await answerOf([ready]);
  const after = await answerOf([running]);
  expect(actionSet(after)).not.toBe(actionSet(before));
  const calls = device(actionSet(before), [ready], [running]);
  const started = Date.now();
  const result = await WorkSources.wait({ paths, cwd: root, timeoutSeconds: 60 });
  expect(result).toMatchObject({
    tag: "Ok",
    value: { reason: "next_actions_changed", data: after },
  });
  expect(Date.now() - started).toBeLessThan(30000);
  expect(calls.read).toHaveBeenCalledTimes(2);
  expect(calls.finish).toHaveBeenCalledWith(
    paths,
    { repository: "example/one", scope: "" },
    actionSet(after),
  );
}, 30000);

test("a refused read ends the wait with its refusal and releases the lease", async () => {
  const calls = device(null);
  calls.read.mockReturnValueOnce(Err({ reason: "state_busy" as const, detail: "busy" }));
  expect(await WorkSources.wait({ paths, cwd: root, timeoutSeconds: 300 })).toMatchObject({
    tag: "Err",
    error: { reason: "state_busy", detail: "busy" },
  });
  expect(calls.finish).not.toHaveBeenCalled();
  expect(calls.released).toHaveBeenCalledTimes(1);
});

test("a refused start records nothing and holds no lease", async () => {
  const calls = device(null);
  calls.start.mockReturnValue(Err({ reason: "state_busy" as const, detail: "busy" }));
  expect(await WorkSources.wait({ paths, cwd: root, timeoutSeconds: 300 })).toMatchObject({
    tag: "Err",
    error: { reason: "state_busy" },
  });
  expect(calls.hold).not.toHaveBeenCalled();
  expect(calls.read).not.toHaveBeenCalled();
});

const pending = storedSource([
  { key: "a", completion: "report", state: "ready" },
  { key: "b", completion: "report", state: "ready", dependencies: ["a"] },
]);

function supervision(...sources: { id: string; waiting: boolean }[]) {
  return spyOn(DeviceState, "readSupervision").mockReturnValue(
    Ok(sources.map((source) => ({ ...source, repository: "example/one" }))),
  );
}

test("a supervised source with running work and no wait from the session is unwatched", async () => {
  const read = supervision({ id: "one", waiting: false });
  const rows = spyOn(DeviceState, "readSources").mockReturnValue(Ok([running]));
  expect(await WorkSources.unwatched({ paths, cwd: root, session: "ses-1" })).toMatchObject({
    tag: "Ok",
    value: ["one"],
  });
  expect(read).toHaveBeenCalledWith(paths, "ses-1");
  expect(rows).toHaveBeenCalledWith(paths, "example/one", "one");
});

test("a covered source, work that waits only for dependencies, or no running work is watched", async () => {
  supervision({ id: "one", waiting: true }, { id: "two", waiting: false });
  const rows = spyOn(DeviceState, "readSources");
  for (const answer of [[ready], [pending], []]) {
    rows.mockReturnValueOnce(Ok(answer));
    expect(await WorkSources.unwatched({ paths, cwd: root, session: "ses-1" })).toMatchObject({
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
  expect(await WorkSources.unwatched({ paths, cwd: root, session: "ses-1" })).toMatchObject({
    tag: "Err",
    error: failure,
  });
});
