import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { Err, ErrAsync, Ok, OkAsync, fromPromise } from "unthrown";
import { PullRequests } from "../pull-requests/main.ts";
import { DeviceState } from "../device-state/main.ts";
import { Environment } from "../environment/main.ts";
import { OperatorHome } from "../operator-home/main.ts";
import { Projects } from "../projects/main.ts";
import { WorkSources } from "./main.ts";
import { actionKey, addKeys, dropKeys, eventKey } from "./coordination.ts";
import { storedLaunch, storedReport, storedSource } from "./source-fixture.ts";

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

const supervisor = { pane: "pane-1", session: "ses-1" };

/** The device for a wait from the session, or from no session. */
function device(stored: string | null, session: string | undefined, ...reads: (typeof ready)[][]) {
  spyOn(Environment, "read").mockReturnValue({
    ...Environment.read(),
    HERDR_PANE_ID: session === undefined ? undefined : "pane-1",
    OPENCODE_SESSION_ID: session,
    CLAUDE_CODE_SESSION_ID: undefined,
  });
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

test("coordination returns scoped review upkeep and acknowledges only its returned event", async () => {
  const calls = device(null, undefined, []);
  const event = { url: "https://github.com/example/one/pull/7", kind: "round_started", round: 2 };
  const reviewUpkeep = mock(() => OkAsync({ events: [event], requests: [] }));
  expect(
    await WorkSources.wait({ paths, cwd: root, sourceId: "one", timeoutSeconds: 0, reviewUpkeep }),
  ).toMatchObject({
    tag: "Ok",
    value: { reason: "next_actions_changed", data: { sources: [], events: [event], requests: [] } },
  });
  expect(reviewUpkeep).toHaveBeenCalledWith({
    scopes: [{ repository: "example/one", sourceIds: ["one"], manual: false }],
    observe: true,
  });
  expect(finished(calls, null)).toBe(addKeys([eventKey(event)])(null));
  expect(calls.released).toHaveBeenCalledTimes(1);
});

test.each(["Err", "Defect"])(
  "review upkeep %s acknowledges nothing and releases the wait lease",
  async (tag) => {
    const calls = device(null, undefined, []);
    const failure = {
      reason: "state_busy" as const,
      detail: "Synthetic review read failed.",
      next: { command: "operator next --wait", why: "Retry." },
    };
    const cause = new TypeError("Synthetic review upkeep defect");
    const reviewUpkeep = mock(() =>
      tag === "Err"
        ? ErrAsync(failure)
        : fromPromise(Promise.reject(cause), (error, defect) => defect(error)).map(() => ({
            events: [],
            requests: [],
          })),
    );
    const result = await WorkSources.wait({ paths, cwd: root, timeoutSeconds: 0, reviewUpkeep });
    if (tag === "Err") expect(result).toMatchObject({ tag: "Err", error: failure });
    else {
      expect(result.tag).toBe("Defect");
      if (result.tag === "Defect") expect(result.cause).toBe(cause);
    }
    expect(reviewUpkeep).toHaveBeenCalledTimes(1);
    expect(calls.change).not.toHaveBeenCalled();
    expect(calls.finish).not.toHaveBeenCalled();
    expect(calls.released).toHaveBeenCalledTimes(1);
  },
);

test("a refused source read runs no consuming review upkeep and acknowledges nothing", async () => {
  const calls = device(null, undefined);
  calls.read.mockReturnValue(
    Err({
      reason: "state_busy",
      detail: "Synthetic source read failed.",
      next: { command: "operator next --wait", why: "Retry." },
    }),
  );
  const reviewUpkeep = mock(() => OkAsync({ events: [], requests: [] }));
  expect(
    await WorkSources.wait({ paths, cwd: root, timeoutSeconds: 0, reviewUpkeep }),
  ).toMatchObject({ tag: "Err", error: { reason: "state_busy" } });
  expect(reviewUpkeep).not.toHaveBeenCalled();
  expect(calls.change).not.toHaveBeenCalled();
  expect(calls.finish).not.toHaveBeenCalled();
  expect(calls.released).toHaveBeenCalledTimes(1);
});

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
  expect(calls.start).toHaveBeenCalledWith(paths, target, { pane: null, session: null });
  expect(calls.hold).toHaveBeenCalledWith(paths, target);
  expect(finished(calls, null)).toBe(addKeys([readyKey])(null));
  expect(calls.released).toHaveBeenCalledTimes(1);
  expect(calls.read).toHaveBeenCalledWith(paths, "example/one", undefined);
  expect(calls.supervision).not.toHaveBeenCalled();
});

test("a quiet first wait initializes its acknowledgement set without ending the live wait", async () => {
  const calls = device(null, undefined, [running], [running]);
  calls.read.mockReturnValue(Ok([running]));
  calls.stored.mockReturnValueOnce(Ok(null)).mockReturnValue(Ok("[]"));
  let now = 0;
  spyOn(Date, "now").mockImplementation(() => now);
  spyOn(Bun, "sleep").mockImplementation(async () => {
    expect(calls.finish).not.toHaveBeenCalled();
    expect(calls.change).toHaveBeenCalledWith(
      paths,
      { repository: "example/one", scope: "" },
      expect.any(Function),
      { initialize: true },
    );
    now = 3000;
  });
  expect(await WorkSources.wait({ paths, cwd: root, timeoutSeconds: 3 })).toMatchObject({
    tag: "Ok",
    value: { reason: "next_wait_timed_out" },
  });
  expect(calls.finish).toHaveBeenCalledTimes(1);
});

test.each([
  {
    oldAction: "resume_worker",
    oldReason: "follow_up_returned",
    action: "worker_attention",
    reason: "follow_up_returned",
    state: "reported",
    decision: "returned",
    cleanup: null,
  },
  {
    oldAction: "retry_cleanup",
    oldReason: "cleanup_failed",
    action: "clean_up",
    reason: "cleanup_failed",
    state: "completed",
    decision: "accepted",
    cleanup: "failed",
  },
  {
    oldAction: "retry_cleanup",
    oldReason: "cleanup_unfinished",
    action: "clean_up",
    reason: "cleanup_stopped",
    state: "completed",
    decision: "accepted",
    cleanup: "pending",
  },
])(
  "$oldAction/$oldReason returns once in each existing wait scope",
  async ({ oldAction, oldReason, action, reason, state, decision, cleanup }) => {
    const source = storedSource(
      [
        { key: "a", completion: "report", state },
        { key: "b", completion: "report", state: "running" },
      ],
      {
        launches: [storedLaunch("a")],
        reports: [storedReport("a", { decision, cleanupState: cleanup })],
      },
    );
    const old = addKeys([
      actionKey("one", { assignment: "a", action: oldAction, reason: oldReason }),
    ])(null);
    for (const { sourceId, session, scope } of [
      { sourceId: undefined, session: undefined, scope: "" },
      { sourceId: "one", session: undefined, scope: "one" },
      { sourceId: undefined, session: "ses-1", scope: "session:ses-1" },
    ]) {
      const calls = device(old, session, [source]);
      const input = { paths, cwd: root, sourceId, timeoutSeconds: 0 };
      expect(await WorkSources.wait(input)).toMatchObject({
        tag: "Ok",
        value: {
          reason: "next_actions_changed",
          data: { sources: [{ actions: [{ assignment: "a", action, reason }] }] },
        },
      });
      expect(calls.start).toHaveBeenCalledWith(
        paths,
        { repository: "example/one", scope },
        { pane: session === undefined ? null : "pane-1", session: session ?? null },
      );
      const returned = finished(calls, old) ?? expect.unreachable("No action keys were stored.");
      mock.restore();
      device(returned, session, [source]);
      expect(await WorkSources.wait(input)).toMatchObject({
        tag: "Ok",
        value: { reason: "next_wait_timed_out", data: { sources: [] } },
      });
      mock.restore();
    }
  },
);

test("parked batch failures stop the coordination read without acknowledging actions and release its lease", async () => {
  const calls = device(null, undefined, [ready]);
  const failure = {
    reason: "github_failed",
    detail: "Synthetic read failed.",
    next: { command: "operator next --wait", why: "Retry observation." },
  };
  spyOn(PullRequests, "observeParked").mockReturnValue(ErrAsync(failure));
  expect(
    await WorkSources.wait({
      paths,
      cwd: root,
      timeoutSeconds: 0,
      observeParked: () => PullRequests.observeParked({ paths }),
    }),
  ).toMatchObject({ tag: "Err", error: failure });
  expect(calls.read).not.toHaveBeenCalled();
  expect(calls.finish).not.toHaveBeenCalled();
  expect(calls.released).toHaveBeenCalledTimes(1);
});

test("a parked batch defect retains its original cause rather than returning a quiet timeout", async () => {
  const calls = device(null, undefined, [ready]);
  const cause = new TypeError("Synthetic batch defect");
  spyOn(PullRequests, "observeParked").mockReturnValue(
    fromPromise(Promise.reject(cause), (error, defect) => defect(error)).map(() => undefined),
  );
  const result = await WorkSources.wait({
    paths,
    cwd: root,
    timeoutSeconds: 0,
    observeParked: () => PullRequests.observeParked({ paths }),
  });
  expect(result.tag).toBe("Defect");
  if (result.tag === "Defect") expect(result.cause).toBe(cause);
  expect(calls.finish).not.toHaveBeenCalled();
  expect(calls.released).toHaveBeenCalledTimes(1);
});

test("a scope's first wait records a source's end without returning it", async () => {
  const calls = device(null, "ses-1", [ended]);
  const result = await WorkSources.wait({ paths, cwd: root, timeoutSeconds: 0 });
  expect(result).toMatchObject({ tag: "Ok", value: { data: { sources: [] } } });
  const endedKey = actionKey("one", { action: "source_ended", reason: "finished" });
  expect(finished(calls, null)).toBe(addKeys([endedKey])(null));
});

test("an unchanged set times out with no actions, or with the whole answer when asked", async () => {
  const stored = addKeys([readyKey])(null);
  const calls = device(stored, "ses-1", [ready]);
  const quiet = await WorkSources.wait({ paths, cwd: root, sourceId: "one", timeoutSeconds: 0 });
  expect(quiet).toMatchObject({
    tag: "Ok",
    value: { reason: "next_wait_timed_out", data: { sources: [] } },
  });
  expect(calls.start).toHaveBeenCalledWith(
    paths,
    { repository: "example/one", scope: "one" },
    supervisor,
  );
  expect(calls.read).toHaveBeenCalledWith(paths, "example/one", "one");
  expect(finished(calls, stored)).toBe(stored);
  expect(calls.supervision).not.toHaveBeenCalled();
  const full = await answerOf([ready]);
  device(stored, "ses-1", [ready]);
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

test("a session wait without a source covers the session's sources in every project", async () => {
  const calls = device(null, "ses-1");
  calls.supervision.mockReturnValue(
    Ok([
      { id: "one", repository: "example/one", waiting: true },
      { id: "one", repository: "example/two", waiting: true },
    ]),
  );
  calls.read.mockReturnValueOnce(Ok([ready])).mockReturnValueOnce(Ok([pending]));
  const result = await WorkSources.wait({ paths, cwd: root, timeoutSeconds: 300 });
  const target = { repository: "example/one", scope: "session:ses-1" };
  expect(calls.start).toHaveBeenCalledWith(paths, target, supervisor);
  expect(calls.supervision).toHaveBeenCalledWith(paths, "ses-1");
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

test("a failed write of the stored set ends the wait with its failure", async () => {
  const calls = device(addKeys([readyKey])(null), undefined, [running]);
  calls.change.mockReturnValue(
    Err({
      reason: "state_busy" as const,
      detail: "busy",
      next: {
        decider: "super-agent",
        question: "When has the simulated state operation finished?",
      },
    }),
  );
  expect(await WorkSources.wait({ paths, cwd: root, timeoutSeconds: 300 })).toMatchObject({
    tag: "Err",
    error: { reason: "state_busy" },
  });
  expect(calls.finish).not.toHaveBeenCalled();
  expect(calls.released).toHaveBeenCalledTimes(1);
});

test("a refused read ends the wait with its refusal and releases the lease", async () => {
  const calls = device(null, undefined);
  calls.read.mockReturnValueOnce(
    Err({
      reason: "state_busy" as const,
      detail: "busy",
      next: {
        decider: "super-agent",
        question: "When has the simulated state operation finished?",
      },
    }),
  );
  expect(await WorkSources.wait({ paths, cwd: root, timeoutSeconds: 300 })).toMatchObject({
    tag: "Err",
    error: { reason: "state_busy", detail: "busy" },
  });
  expect(calls.finish).not.toHaveBeenCalled();
  expect(calls.released).toHaveBeenCalledTimes(1);
});

test("a refused start records nothing and holds no lease", async () => {
  const calls = device(null, undefined);
  calls.start.mockReturnValue(
    Err({
      reason: "state_busy" as const,
      detail: "busy",
      next: {
        decider: "super-agent",
        question: "When has the simulated state operation finished?",
      },
    }),
  );
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

test("a session command acknowledges the actions that it added to its source", async () => {
  const acknowledge = acknowledged([running], [ready]);
  const change = mock(async () => "done");
  expect(
    await WorkSources.acknowledgeOwnChange(
      { paths, cwd: root, session: "ses-1", sourceId: "one", assignment: "a" },
      change,
    ),
  ).toBe("done");
  expect(change).toHaveBeenCalledTimes(1);
  expect(acknowledge).toHaveBeenCalledWith(paths, "ses-1", expect.any(Function));
  expect(acknowledge.mock.calls[0]?.[2](null)).toBe(addKeys([readyKey])(null));
});

test("a session command acknowledges nothing for another assignment, another source, or no change", async () => {
  for (const selector of [
    { sourceId: "one", assignment: "b" },
    { sourceId: "two" },
    { sourceId: undefined },
  ]) {
    const acknowledge = acknowledged([running], [ready]);
    await WorkSources.acknowledgeOwnChange(
      { paths, cwd: root, session: "ses-1", ...selector },
      async () => undefined,
    );
    expect(acknowledge).not.toHaveBeenCalled();
    mock.restore();
  }
  const acknowledge = acknowledged([ready], [ready]);
  await WorkSources.acknowledgeOwnChange(
    { paths, cwd: root, session: "ses-1", sourceId: "one" },
    async () => undefined,
  );
  expect(acknowledge).not.toHaveBeenCalled();
});

test("a registration acknowledges the actions of its new source", async () => {
  const acknowledge = acknowledged([], [ready]);
  await WorkSources.acknowledgeOwnChange(
    { paths, cwd: root, session: "ses-1" },
    async () => undefined,
  );
  expect(acknowledge.mock.calls[0]?.[2](null)).toBe(addKeys([readyKey])(null));
});

test("a failed acknowledgement keeps the command's result", async () => {
  acknowledged([running], [ready]).mockReturnValue(
    Err({
      reason: "state_busy" as const,
      detail: "busy",
      next: {
        decider: "super-agent",
        question: "When has the simulated state operation finished?",
      },
    }),
  );
  expect(
    await WorkSources.acknowledgeOwnChange(
      { paths, cwd: root, session: "ses-1", sourceId: "one" },
      async () => "done",
    ),
  ).toBe("done");
});

test("a failed read runs the command and acknowledges nothing", async () => {
  project();
  spyOn(DeviceState, "readSources").mockReturnValue(
    Err({
      reason: "state_busy" as const,
      detail: "busy",
      next: {
        decider: "super-agent",
        question: "When has the simulated state operation finished?",
      },
    }),
  );
  const acknowledge = spyOn(DeviceState, "acknowledgeCoordinationWaits");
  expect(
    await WorkSources.acknowledgeOwnChange(
      { paths, cwd: root, session: "ses-1" },
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

test("a supervised source with a live worker and no wait from the session is unwatched", async () => {
  const read = supervised({ id: "one", waiting: false });
  const rows = spyOn(DeviceState, "readSources").mockReturnValue(
    Ok([{ ...running, launches: [storedLaunch("a")] }]),
  );
  expect(await WorkSources.unwatched({ paths, cwd: root, session: "ses-1" })).toMatchObject({
    tag: "Ok",
    value: ["one"],
  });
  expect(read).toHaveBeenCalledWith(paths, "ses-1");
  expect(rows).toHaveBeenCalledWith(paths, "example/one", "one");
});

test("a covered source, work that waits only for dependencies, or no running work is watched", async () => {
  supervised({ id: "one", waiting: true }, { id: "two", waiting: false });
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
  const failure = {
    reason: "state_missing" as const,
    detail: "missing",
    next: { command: "operator project register", why: "Initialize the test device explicitly." },
  };
  spyOn(DeviceState, "readSupervision").mockReturnValue(Err(failure));
  expect(await WorkSources.unwatched({ paths, cwd: root, session: "ses-1" })).toMatchObject({
    tag: "Err",
    error: failure,
  });
});
