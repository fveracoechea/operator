import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { Err, Ok, fromPromise } from "unthrown";
import { DeviceState } from "../device-state/main.ts";
import { ToolInvocation } from "../tool-invocation/main.ts";
import { OperatorHome } from "../operator-home/main.ts";
import { GithubApi } from "../github-api/main.ts";
import { prDevice, git, pullRequestBody, succeeded } from "./device-fixture.ts";
import type { Owner } from "./owner.ts";
import { z } from "zod";
import { parkedObservation, parkQuietWait, observeParked } from "./parking.ts";
import type { Observation } from "./github.ts";

const row: Parameters<typeof parkedObservation>[0] = {
  sourceId: "s",
  assignment: "a",
  repository: "owner/repo",
  number: 7,
  url: "https://github.com/owner/repo/pull/7",
  branch: "task/a",
  associatedAt: "then",
  progress: '{"seen":[],"failures":[],"eligibleHead":null}',
  readiness: "explicit-ready",
  waitState: "idle",
  waitAt: null,
  waitOwnerPid: null,
  waitLeaseAt: null,
  mergedHead: null,
  mergeCommit: null,
  mergedAt: null,
  relay: null,
  parkingRaw:
    '{\n  "state": "parked", "head": "h", "launchId": "l", "at": "then",\n  "events": [], "note": null\n}',
  parking: {
    launchId: "l",
    head: "h",
    at: "then",
    note: null,
    state: "parked",
    events: [],
    parentSeen: false,
  },
};
const observed: Observation = {
  state: "OPEN",
  head: "h",
  mergeCommit: null,
  mergeMethod: "squash",
  base: "main",
  defaultBranch: "main",
  draft: false,
  approved: false,
  unresolvedThreads: 0,
  feedback: [],
  checks: [],
  checksComplete: true,
};

afterEach(() => mock.restore());

const paths = OperatorHome.resolve({ HOME: "/tmp/opencode/issue390-unused-home", PATH: "" });

test("an unclaimed device batch performs no GitHub or persistence work", async () => {
  spyOn(DeviceState, "claimParkedRead").mockReturnValue(Ok(null));
  const github = spyOn(GithubApi, "call");
  const finish = spyOn(DeviceState, "finishParkedRead");
  expect(await observeParked({ paths })).toMatchObject({ tag: "Ok", value: undefined });
  expect(github).not.toHaveBeenCalled();
  expect(finish).not.toHaveBeenCalled();
});

test.each(["Err", "Defect", "stale"] as const)(
  "a %s batch persistence outcome never records a merge and releases its claim",
  async (tag) => {
    spyOn(DeviceState, "claimParkedRead").mockReturnValue(Ok({ at: "claim", rows: [row] }));
    const body = pullRequestBody({ state: "MERGED", head: "h", mergeCommit: "merged" });
    spyOn(GithubApi, "call").mockResolvedValue(
      succeeded({ data: { viewer: body.data.viewer, r0: body.data.repository } }),
    );
    const cause = new TypeError("persist failure");
    const failed =
      tag === "Err"
        ? Err({
            reason: "state_io_failed" as const,
            detail: "persist failed",
            next: { command: "operator next", why: "Inspect state" },
          })
        : tag === "stale"
          ? Ok(false)
          : await fromPromise(Promise.reject(cause), (error, defect) => defect(error));
    const finish = spyOn(DeviceState, "finishParkedRead").mockImplementation(
      (_paths, _at, updates) => (updates === null ? Ok(true) : failed),
    );
    const merged = spyOn(DeviceState, "recordPullRequestMerge");
    const result = await observeParked({ paths });
    expect(result.tag).toBe(tag === "stale" ? "Ok" : tag);
    if (result.tag === "Defect") expect(result.cause).toBe(cause);
    expect(finish).toHaveBeenLastCalledWith(paths, "claim", null);
    expect(merged).not.toHaveBeenCalled();
  },
);

test("a complete empty batch acknowledges once and releases its lease", async () => {
  spyOn(DeviceState, "claimParkedRead").mockReturnValue(Ok({ at: "claim", rows: [] }));
  const finish = spyOn(DeviceState, "finishParkedRead").mockReturnValue(Ok(true));
  const github = spyOn(GithubApi, "call");
  expect(await observeParked({ paths })).toMatchObject({ tag: "Ok" });
  expect(finish.mock.calls.map((call) => call[2])).toEqual([[], null]);
  expect(github).not.toHaveBeenCalled();
});

test("a parked observation forwards the exact persisted JSON bytes as its comparison witness", async () => {
  const update = parkedObservation(row, { observed, parent: null });
  expect(update.previous).toBe(row.parkingRaw);
  expect(update.parking).toEqual(row.parking);
  spyOn(DeviceState, "claimParkedRead").mockReturnValue(Ok({ at: "claim", rows: [row] }));
  const body = pullRequestBody({ head: "h" });
  spyOn(GithubApi, "call").mockResolvedValue(
    succeeded({ data: { viewer: body.data.viewer, r0: body.data.repository } }),
  );
  const finish = spyOn(DeviceState, "finishParkedRead").mockReturnValue(Ok(true));
  expect(await observeParked({ paths })).toMatchObject({ tag: "Ok" });
  expect(finish).toHaveBeenNthCalledWith(1, paths, "claim", [
    expect.objectContaining({ sourceId: "s", assignment: "a", previous: row.parkingRaw }),
  ]);
  expect(finish).toHaveBeenLastCalledWith(paths, "claim", null);
});

test.each([true, false])(
  "a parked merge runs cleanup only after verified matching-head persistence: %s",
  async (matches) => {
    await using device = await prDevice();
    const owner = startOwner(device);
    const parked = {
      ...row,
      sourceId: owner.sourceId,
      assignment: owner.assignment,
      repository: owner.repository,
      parking: { ...row.parking, launchId: owner.launchId },
    };
    spyOn(DeviceState, "claimParkedRead").mockReturnValue(Ok({ at: "claim", rows: [parked] }));
    const body = pullRequestBody({
      state: "MERGED",
      head: matches ? "h" : "foreign",
      mergeCommit: "merged",
    });
    spyOn(GithubApi, "call").mockResolvedValue(
      succeeded({ data: { viewer: body.data.viewer, r0: body.data.repository } }),
    );
    const finish = spyOn(DeviceState, "finishParkedRead").mockReturnValue(Ok(true));
    const merged = spyOn(DeviceState, "recordPullRequestMerge").mockReturnValue(
      Ok({ changed: true }),
    );
    const failure = {
      reason: "cleanup_not_found" as const,
      detail: "cleanup failure",
      next: { command: "operator next", why: "Inspect cleanup" },
    };
    const cleanup = spyOn(DeviceState, "claimCleanup").mockReturnValue(Err(failure));
    const result = await observeParked({ paths: device.paths });
    expect(result.tag).toBe(matches ? "Err" : "Ok");
    expect(merged).toHaveBeenCalledTimes(matches ? 1 : 0);
    expect(cleanup).toHaveBeenCalledTimes(matches ? 1 : 0);
    if (matches && result.tag === "Err") expect(result.error).toBe(failure);
    expect(finish).toHaveBeenLastCalledWith(device.paths, "claim", null);
  },
);

test.each(["Err", "Defect"] as const)(
  "a batch read retains its primary Defect when lease release is also %s",
  async (tag) => {
    spyOn(DeviceState, "claimParkedRead").mockReturnValue(Ok({ at: "claim", rows: [row] }));
    const primary = new TypeError("original batch read");
    spyOn(GithubApi, "call").mockRejectedValue(primary);
    const secondary = new TypeError("release defect");
    const release =
      tag === "Err"
        ? Err({
            reason: "state_io_failed" as const,
            detail: "secondary",
            next: { command: "operator next", why: "Inspect lease" },
          })
        : await fromPromise(Promise.reject(secondary), (error, defect) => defect(error));
    const finish = spyOn(DeviceState, "finishParkedRead").mockReturnValue(release);
    const diagnostics = spyOn(console, "error").mockImplementation(() => {});
    const result = await observeParked({ paths });
    expect(result.tag).toBe("Defect");
    if (result.tag === "Defect") expect(result.cause).toBe(primary);
    expect(finish).toHaveBeenCalledWith(paths, "claim", null);
    expect(finish).toHaveBeenCalledTimes(1);
    expect(diagnostics).toHaveBeenCalledWith(
      "parked_read_release",
      expect.objectContaining({ secondary: release }),
    );
  },
);

function startOwner(device: Awaited<ReturnType<typeof prDevice>>): Owner {
  const started = device.start("parent");
  const owners = DeviceState.worktreeOwners(device.paths).getOr([]);
  const owner = owners[0] ?? expect.unreachable("Missing owner");
  return { ...owner, worktreePath: started.worktree, branch: "task/parent" };
}

test("a successful quiet park retains only its supplied note and starts the recorded handoff", async () => {
  await using device = await prDevice();
  const owner = startOwner(device);
  const park = spyOn(DeviceState, "parkPullRequest").mockReturnValue(
    Ok({ ...row.parking, state: "parking" }),
  );
  spyOn(ToolInvocation, "detach").mockReturnValue(123);
  const handoff = spyOn(DeviceState, "startHandoff").mockReturnValue(Ok(undefined));
  expect(
    await parkQuietWait({ paths: device.paths, parkNote: "only park note" }, owner, observed),
  ).toMatchObject({ tag: "Ok", value: true });
  const note = park.mock.calls[0]?.[2].note ?? expect.unreachable("Missing retained park note");
  expect(await Bun.file(note).text()).toBe("only park note");
  expect(handoff).toHaveBeenCalledWith(device.paths, owner.sourceId, owner.assignment, 123);
});

test("a quiet park without a supplied note never copies the reviewer note", async () => {
  await using device = await prDevice();
  const owner = { ...startOwner(device), readiness: JSON.stringify({ note: "/reviewer/note.md" }) };
  const park = spyOn(DeviceState, "parkPullRequest").mockReturnValue(Ok(row.parking));
  spyOn(ToolInvocation, "detach").mockReturnValue(123);
  spyOn(DeviceState, "startHandoff").mockReturnValue(Ok(undefined));
  const write = spyOn(Bun, "write");
  expect(await parkQuietWait({ paths: device.paths }, owner, observed)).toMatchObject({
    tag: "Ok",
    value: true,
  });
  expect(park.mock.calls[0]?.[2]).toEqual({ head: "h", note: null });
  expect(write).not.toHaveBeenCalled();
});

test("incomplete checks on the local pushed head refuse parking without a note or handoff", async () => {
  await using device = await prDevice();
  const owner = startOwner(device);
  const park = spyOn(DeviceState, "parkPullRequest");
  const detached = spyOn(ToolInvocation, "detach");
  const write = spyOn(Bun, "write");
  const result = await parkQuietWait({ paths: device.paths, parkNote: "not retained" }, owner, {
    ...observed,
    head: git(owner.worktreePath, "rev-parse", "HEAD"),
    checksComplete: false,
    checks: Array.from({ length: 100 }, (_, index) => ({
      name: `ci-${index}`,
      state: "passing",
      url: null,
    })),
  });
  expect(result).toMatchObject({
    tag: "Err",
    error: { reason: "pr_checks_unknown", next: { command: "operator pr wait" } },
  });
  expect(park).not.toHaveBeenCalled();
  expect(detached).not.toHaveBeenCalled();
  expect(write).not.toHaveBeenCalled();
});

test("an unknown check rollup on the worker head does not permit quiet parking", async () => {
  await using device = await prDevice();
  const owner = startOwner(device);
  const park = spyOn(DeviceState, "parkPullRequest");
  expect(
    await parkQuietWait({ paths: device.paths }, owner, {
      ...observed,
      head: git(owner.worktreePath, "rev-parse", "HEAD"),
    }),
  ).toMatchObject({ tag: "Err", error: { reason: "pr_checks_unknown" } });
  expect(park).not.toHaveBeenCalled();
});

test.each(["Err", "Defect"] as const)(
  "a partial park-note write is removed before its original %s returns",
  async (tag) => {
    await using device = await prDevice();
    const owner = startOwner(device);
    const write = Bun.write;
    const cause =
      tag === "Err"
        ? Object.assign(new Error("partial park write"), { code: "EIO" })
        : new TypeError("partial write defect");
    let note = "";
    spyOn(Bun, "write").mockImplementation(async (...args) => {
      note = z.string().parse(args[0]);
      await write(note, "partial park-only", { createPath: true });
      return Promise.reject(cause);
    });
    const park = spyOn(DeviceState, "parkPullRequest");
    const detached = spyOn(ToolInvocation, "detach");
    const result = await parkQuietWait(
      { paths: device.paths, parkNote: "park-only" },
      owner,
      observed,
    );
    expect(result.tag).toBe(tag);
    if (result.tag === "Defect") expect(result.cause).toBe(cause);
    if (result.tag === "Err") expect(result.error.reason).toBe("pr_io_failed");
    expect(note).toContain("/park-");
    expect(await Bun.file(note).exists()).toBe(false);
    expect(park).not.toHaveBeenCalled();
    expect(detached).not.toHaveBeenCalled();
  },
);

test.each([
  ["Err", "Err"],
  ["Err", "Defect"],
  ["Defect", "Err"],
  ["Defect", "Defect"],
] as const)(
  "a parking state %s retains its primary identity when note deletion is %s",
  async (tag, cleanupTag) => {
    await using device = await prDevice();
    const owner = startOwner(device);
    const cause = new TypeError("original parking defect");
    const primary =
      tag === "Err"
        ? Err({
            reason: "park_refused",
            detail: "primary",
            next: { command: "operator next", why: "Inspect parking" },
          })
        : await fromPromise(Promise.reject(cause), (error, defect) => defect(error));
    spyOn(DeviceState, "parkPullRequest").mockReturnValue(primary);
    const file = Bun.file;
    const secondary =
      cleanupTag === "Err"
        ? Object.assign(new Error("note delete refused"), { code: "EACCES" })
        : new TypeError("note delete defect");
    spyOn(Bun, "file").mockImplementation((...args) => {
      const name = z.string().parse(args[0]);
      const result = file(name);
      if (name.includes("/park-")) spyOn(result, "delete").mockRejectedValue(secondary);
      return result;
    });
    const diagnostics = spyOn(console, "error").mockImplementation(() => {});
    const detached = spyOn(ToolInvocation, "detach");
    const result = await parkQuietWait(
      { paths: device.paths, parkNote: "park only" },
      owner,
      observed,
    );
    expect(result.tag).toBe(primary.tag);
    if (result.tag === "Defect") expect(result.cause).toBe(cause);
    if (result.tag === "Err" && primary.tag === "Err") expect(result.error).toBe(primary.error);
    expect(diagnostics).toHaveBeenCalledWith("park_note_cleanup", expect.anything());
    const reported = z
      .object({ secondary: z.object({ tag: z.string() }) })
      .parse(diagnostics.mock.calls[0]?.[1]);
    expect(reported.secondary.tag).toBe(cleanupTag);
    expect(detached).not.toHaveBeenCalled();
  },
);

test("quiet reads wake nothing and newly guarded merge eligibility is retained exactly once", () => {
  const quiet = parkedObservation(row, { observed, parent: null });
  expect(quiet.parking.events).toEqual([]);
  expect(quiet.progress).toBe(row.progress);
  const eligible = parkedObservation(row, {
    observed: {
      ...observed,
      approved: true,
      checks: [{ name: "ci", state: "passing", url: null }],
    },
    parent: null,
  });
  expect(eligible.parking.events).toEqual(['{"kind":"merge_eligible","head":"h"}']);
  expect(JSON.parse(eligible.progress)).toEqual({ seen: [], failures: [], eligibleHead: "h" });
  expect(
    parkedObservation(
      { ...row, ...eligible },
      {
        observed: {
          ...observed,
          approved: true,
          checks: [{ name: "ci", state: "passing", url: null }],
        },
        parent: null,
      },
    ).parking.events,
  ).toEqual(eligible.parking.events);
  const own = parkedObservation(row, {
    observed: {
      ...observed,
      feedback: [
        {
          id: "mine",
          kind: "comment",
          body: "My earlier reply.",
          author: "owner",
          fromViewer: true,
          operatorReview: false,
          url: "https://comment/mine",
          reviewState: null,
          path: null,
          threadResolved: null,
        },
      ],
    },
    parent: null,
  });
  expect(own.parking.events).toEqual([]);
  expect(own.progress).toBe(row.progress);
});

test("new feedback and CI failures commit their independent cursors with durable events once", () => {
  const facts = {
    observed: {
      ...observed,
      feedback: [
        {
          id: "C1",
          kind: "comment" as const,
          body: "Check retry.",
          author: "person",
          fromViewer: false,
          operatorReview: false,
          url: "https://comment/1",
          reviewState: null,
          path: null,
          threadResolved: null,
        },
      ],
      checks: [{ name: "ci", state: "failing" as const, url: "https://ci" }],
    },
    parent: null,
  };
  const first = parkedObservation(row, facts);
  expect(
    first.parking.events.map(
      (event) => z.object({ kind: z.string() }).parse(JSON.parse(event)).kind,
    ),
  ).toEqual(["feedback", "checks_failed"]);
  expect(JSON.parse(first.progress)).toEqual({
    seen: ["C1"],
    failures: ["h:ci"],
    eligibleHead: null,
  });
  const repeated = parkedObservation({ ...row, ...first }, facts);
  expect(repeated.parking.events).toEqual(first.parking.events);
  expect(repeated.progress).toBe(first.progress);
});

test("the recorded parent merging wakes once without relaying or inventing stack facts", () => {
  const relay = {
    parent: { assignment: "parent", number: 6, branch: "task/parent" },
    state: "stacked",
    blocker: null,
    ownerPid: null,
    leaseAt: null,
    rebasedHead: null,
  };
  const stacked = { ...row, relay: JSON.stringify(relay) };
  const parent = { state: "MERGED" as const, head: "parent-head", base: "main" };
  const first = parkedObservation(stacked, { observed, parent });
  expect(first.parking.parentSeen).toBe(true);
  expect(
    first.parking.events.map((event) =>
      z.looseObject({ kind: z.string() }).parse(JSON.parse(event)),
    ),
  ).toEqual([{ kind: "parent_merged", parent: relay.parent, head: "parent-head", base: "main" }]);
  expect(parkedObservation({ ...stacked, ...first }, { observed, parent }).parking.events).toEqual(
    first.parking.events,
  );
  expect(parkedObservation(row, { observed, parent }).parking.events).toEqual([]);
});

test("a close records the abandon frontier rather than a waking launch", () => {
  const closed = parkedObservation(row, {
    observed: { ...observed, state: "CLOSED" },
    parent: null,
  });
  expect(closed.parking.state).toBe("closed");
  expect(closed.parking.events).toEqual([]);
});
