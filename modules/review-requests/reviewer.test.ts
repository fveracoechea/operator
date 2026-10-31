import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
// Bun has no directory creation API.
import { mkdir } from "node:fs/promises";
import { ErrAsync, Ok, OkAsync, fromPromise } from "unthrown";
import { DeviceState } from "../device-state/main.ts";
import { Environment } from "../environment/main.ts";
import { Herdr } from "../herdr/main.ts";
import { WorkerDispatch } from "../worker-dispatch/main.ts";
import { renderReviewerBrief } from "./brief.ts";
import { h1, h2, readRequest, reviewHome, seedRequest, target, url } from "./home-fixture.ts";
import { files, type Round, type Row, type Snapshot } from "./request.ts";
import { claimCleanup, cleanupReviewer, failureOf, launch, syncReviewer } from "./reviewer.ts";

type Home = Awaited<ReturnType<typeof reviewHome>>;
let home: Home;
const environment = Environment.read();

beforeEach(async () => {
  home = await reviewHome();
});

afterEach(async () => {
  mock.restore();
  await home.remove();
});

const launched = {
  name: "started",
  branch: "review/one-pr-7",
  host: "opencode" as const,
  model: "m",
  reasoningEffort: "high",
  profile: null,
  paneId: "p1",
  worktreePath: "/w",
  preparation: null,
  brief: "brief.md",
};

function round(number: number, outcome: string, change: Partial<Round> = {}): Round {
  return {
    requestId: "r1",
    number,
    trigger: "first",
    reviewedCommit: h1,
    draft: `{"n":${number}}`,
    event: "COMMENT",
    body: "body",
    marker: "marker",
    outcome,
    reviewId: null,
    reviewUrl: null,
    postedAt: null,
    warning: null,
    blockers: null,
    ...change,
  };
}

/** A request that this process holds, with the given fields and rounds. */
function held(change: Partial<Omit<Row, "id">> = {}, rounds: Round[] = []) {
  const update = { ownerPid: process.pid, leaseAt: new Date().toISOString(), ...change };
  if (readRequest(home.paths).request === null) seedRequest(home.paths, update);
  else DeviceState.changeReviewRequest(home.paths, { ...target, id: "r1" }, () => Ok({ update }));
  for (const row of rounds)
    DeviceState.changeReviewRequest(home.paths, { ...target, id: "r1" }, () => Ok({ round: row }));
  return readRequest(home.paths);
}

function located() {
  return files(home.paths, { repository: "example/one", id: "r1" });
}

/** Records the order of each hold and its release. */
function watchHold() {
  const events: string[] = [];
  spyOn(DeviceState, "holdReviewRequest").mockImplementation((_paths, id) => {
    events.push(`hold ${id}`);
    return () => events.push(`release ${id}`);
  });
  return events;
}

function socket(path: string | undefined) {
  spyOn(Environment, "read").mockReturnValue({ ...environment, HERDR_SOCKET_PATH: path });
}

function defect<T>(cause: Error | string) {
  return fromPromise(
    () => Promise.reject<T>(cause),
    (thrown, toDefect) => toDefect(thrown),
  );
}

test("a refused or defective result names its failure", () => {
  expect(failureOf({ tag: "Err", error: { reason: "r", detail: "d" } })).toEqual({
    reason: "r",
    detail: "d",
  });
  expect(failureOf({ tag: "Defect", cause: new Error("boom") })).toEqual({
    reason: "review_defect",
    detail: "Error: boom",
  });
});

test("a start with no request, project, or head is a defect, and nothing launches", async () => {
  const launched = spyOn(WorkerDispatch, "launchReviewer");
  const snapshot = held({ head: h1 });
  const lost = { reason: "review_defect", detail: "The start lost its request." };
  for (const broken of [
    { ...snapshot, request: null },
    { ...snapshot, project: null },
    held({ head: null }),
  ])
    expect(await launch({ paths: home.paths }, target, broken, false)).toMatchObject({
      tag: "Err",
      error: lost,
    });
  expect(launched).not.toHaveBeenCalled();
});

test("a first start launches at the exact head, writes the history, and renders the brief", async () => {
  const inputs: Parameters<typeof WorkerDispatch.launchReviewer>[0][] = [];
  spyOn(WorkerDispatch, "launchReviewer").mockImplementation((input) => {
    inputs.push(input);
    return OkAsync(launched);
  });
  const snapshot = held({ head: h1, trigger: "reply" }, [
    round(1, "posted", { reviewUrl: "u1", event: "APPROVE", reviewedCommit: h2 }),
    round(2, "failed"),
  ]);
  expect(
    await launch({ paths: home.paths, profile: "deep" }, target, snapshot, false),
  ).toMatchObject({ tag: "Ok", value: launched });
  const input = inputs[0] ?? expect.unreachable("The reviewer did not launch.");
  expect(input).toMatchObject({
    paths: home.paths,
    checkout: home.checkout,
    repository: "example/one",
    number: 7,
    head: h1,
    exactHead: true,
    nameBase: "one-pr7-review",
    branchBase: "review/one-pr-7",
    profile: "deep",
    reuse: null,
    brief: { file: located().brief },
  });
  const draft = `${located().rounds}/1.json`;
  expect(await Bun.file(draft).text()).toBe('{"n":1}\n');
  expect(await Bun.file(`${located().rounds}/2.json`).exists()).toBe(false);
  expect(input.brief.render({ worktree: "/w", branch: "b" })).toBe(
    renderReviewerBrief({
      url,
      repository: "example/one",
      number: 7,
      origin: "slack",
      head: h1,
      worktree: "/w",
      branch: "b",
      draft: located().draft,
      round: { number: 2, trigger: "reply" },
      history: [
        { number: 1, trigger: "first", reviewedCommit: h2, event: "APPROVE", url: "u1", draft },
      ],
    }),
  );
  // Each launched resource is recorded on the request at once.
  expect(input.record({ name: "reviewer-one" })).toMatchObject({ tag: "Ok" });
  expect(readRequest(home.paths).request?.name).toBe("reviewer-one");
});

test("a replacement reopens the recorded worktree, and a long name is cut at a word", async () => {
  const inputs: Parameters<typeof WorkerDispatch.launchReviewer>[0][] = [];
  spyOn(WorkerDispatch, "launchReviewer").mockImplementation((input) => {
    inputs.push(input);
    return OkAsync(launched);
  });
  const snapshot = held({ head: h1, worktreePath: "/w", branch: "review/b" });
  const long = { ...target, repository: "example/a-very-long-repository-name" };
  await launch({ paths: home.paths }, long, snapshot, true);
  const reopened = held({ head: h1, worktreePath: "/w", branch: null });
  await launch({ paths: home.paths }, target, reopened, true);
  const unplaced = held({ head: h1, worktreePath: null, branch: "review/b" });
  await launch({ paths: home.paths }, target, unplaced, true);
  expect(inputs).toMatchObject([
    {
      exactHead: false,
      nameBase: "a-very-long-repository-name",
      branchBase: "review/a-very-long-repository-name-pr-7",
      reuse: { path: "/w", branch: "review/b" },
    },
    { reuse: null },
    { reuse: null },
  ]);
  // With no trigger and no rounds, the brief names the first round.
  expect(inputs[1]?.brief.render({ worktree: "/w", branch: "b" })).toContain(
    "This is round 1, for the first review.",
  );
});

test("a history that cannot be written stops the start before any launch", async () => {
  const launched = spyOn(WorkerDispatch, "launchReviewer");
  const snapshot = held({ head: h1 }, [round(1, "posted")]);
  await Bun.write(located().rounds, "not a folder", { createPath: true });
  expect(await launch({ paths: home.paths }, target, snapshot, false)).toMatchObject({
    tag: "Err",
    error: { reason: "review_io_failed" },
  });
  expect(launched).not.toHaveBeenCalled();
});

const head = JSON.stringify({ kind: "head", from: h1, to: h2 });
const running = {
  state: "reviewing",
  launchState: "running",
  head: h2,
  name: "reviewer",
  worktreePath: "/w",
  branch: "review/b",
};

test("no request, project, or sync means nothing to give to the reviewer", async () => {
  const prompted = spyOn(Herdr, "prompt");
  const snapshot = held({ ...running, sync: head });
  for (const quiet of [
    { ...snapshot, request: null },
    { ...snapshot, project: null },
    held({ ...running, sync: null }),
  ])
    expect(await syncReviewer(home.paths, target, quiet)).toMatchObject({
      tag: "Ok",
      value: { kind: "none", mode: null },
    });
  expect(prompted).not.toHaveBeenCalled();
});

test("a fast-forward moves the worktree, writes the brief, and prompts the same reviewer", async () => {
  const events = watchHold();
  const moved = spyOn(WorkerDispatch, "moveReviewer").mockReturnValue(
    OkAsync({ mode: "fast-forward" as const }),
  );
  const prompts: { name: string; text: string }[] = [];
  spyOn(Herdr, "prompt").mockImplementation((input) => {
    prompts.push(input);
    return OkAsync(null);
  });
  const snapshot = held(
    { ...running, sync: head, failureReason: "old", failureDetail: "old detail" },
    [round(1, "posted", { reviewUrl: "u1" })],
  );
  expect(await syncReviewer(home.paths, target, snapshot)).toMatchObject({
    tag: "Ok",
    value: { kind: "head", mode: "fast-forward" },
  });
  expect(moved).toHaveBeenCalledWith({
    checkout: home.checkout,
    repository: "example/one",
    number: 7,
    worktree: "/w",
    from: h1,
    to: h2,
  });
  const brief = located().brief;
  expect(prompts).toEqual([
    {
      name: "reviewer",
      text: `PR #7 moved from ${h1} to ${h2} by a fast-forward. Your worktree is now at ${h2}. Review only the new commits: run git log ${h1}..${h2} and git diff ${h1}..${h2}. Check each of your open review threads. Then write a draft for ${h2} and post it. The brief is ${brief}.`,
    },
  ]);
  expect(await Bun.file(brief).text()).toBe(
    renderReviewerBrief({
      url,
      repository: "example/one",
      number: 7,
      origin: "slack",
      head: h2,
      worktree: "/w",
      branch: "review/b",
      draft: located().draft,
      round: { number: 2, trigger: "first" },
      history: [
        {
          number: 1,
          trigger: "first",
          reviewedCommit: h1,
          event: "COMMENT",
          url: "u1",
          draft: `${located().rounds}/1.json`,
        },
      ],
    }),
  );
  expect(readRequest(home.paths).request).toMatchObject({
    sync: null,
    failureReason: null,
    failureDetail: null,
    launchState: "running",
    ownerPid: null,
  });
  expect(events).toEqual(["hold r1", "release r1"]);
});

test("a force push of a new round resets the worktree and names the round", async () => {
  spyOn(WorkerDispatch, "moveReviewer").mockReturnValue(OkAsync({ mode: "force-push" as const }));
  const prompted = spyOn(Herdr, "prompt").mockReturnValue(OkAsync(null));
  const sync = JSON.stringify({ kind: "head", from: h1, to: h2, round: 2, trigger: "reply" });
  const snapshot = held({ ...running, sync });
  expect(await syncReviewer(home.paths, target, snapshot)).toMatchObject({
    tag: "Ok",
    value: { kind: "head", mode: "force-push" },
  });
  expect(prompted).toHaveBeenCalledWith({
    name: "reviewer",
    text: `Review round 2 of PR #7 started, because of an author reply. PR #7 was force-pushed from ${h1} to ${h2}. Your worktree is now at ${h2}. Review the PR again from the start, check each of your open review threads, then write a draft for ${h2} and post it. The brief is ${located().brief}.`,
  });
});

test("a head sync with no worktree only prompts, and a round names its trigger", async () => {
  const moved = spyOn(WorkerDispatch, "moveReviewer");
  const prompted = spyOn(Herdr, "prompt").mockReturnValue(OkAsync(null));
  const cases = [
    [
      { kind: "head", from: h1, to: h2, round: 3 },
      "Review round 3 of PR #7 started, because of new commits. PR #7 was force-pushed",
    ],
    [
      { kind: "head", from: h1, to: h2, round: 3, trigger: "other" },
      "Review round 3 of PR #7 started, because of other. PR #7",
    ],
    [{ kind: "head", from: h1, to: h2 }, "PR #7 was force-pushed"],
  ] as const;
  for (const [sync, start] of cases) {
    prompted.mockClear();
    const snapshot = held({ ...running, worktreePath: null, sync: JSON.stringify(sync) });
    expect(await syncReviewer(home.paths, target, snapshot)).toMatchObject({
      tag: "Ok",
      value: { kind: "head", mode: null },
    });
    const text = prompted.mock.calls[0]?.[0].text ?? "";
    expect(text.startsWith(start), text).toBe(true);
  }
  expect(moved).not.toHaveBeenCalled();
});

test("a round prompt names each trigger in words", async () => {
  const prompted = spyOn(Herdr, "prompt").mockReturnValue(OkAsync(null));
  const brief = located().brief;
  for (const [trigger, words] of [
    ["commits", "new commits"],
    ["reply", "an author reply"],
    ["resolved", "a thread that the author resolved"],
    ["re-request", "a renewed review request"],
    ["other", "other"],
  ]) {
    prompted.mockClear();
    const sync = JSON.stringify({ kind: "round", round: 2, trigger });
    expect(await syncReviewer(home.paths, target, held({ ...running, sync }))).toMatchObject({
      tag: "Ok",
      value: { kind: "round", mode: null },
    });
    expect(prompted).toHaveBeenCalledWith({
      name: "reviewer",
      text: `Review round 2 of PR #7 started, because of ${words}. Your worktree is at ${h2}. Read the brief ${brief} again, check each of your open review threads, and write a new draft for ${h2}.`,
    });
  }
});

test("a refused prompt marks the reviewer interrupted, and a brief with no placement is empty", async () => {
  const prompted = spyOn(Herdr, "prompt").mockReturnValue(
    ErrAsync({ reason: "herdr_failed" as const, detail: "gone" }),
  );
  const sync = JSON.stringify({ kind: "round", round: 1, trigger: "reply" });
  const snapshot = held({
    ...running,
    sync,
    head: null,
    name: null,
    worktreePath: null,
    branch: null,
  });
  expect(await syncReviewer(home.paths, target, snapshot)).toMatchObject({
    tag: "Ok",
    value: { kind: "reviewer_interrupted", mode: null },
  });
  expect(prompted.mock.calls[0]?.[0].name).toBe("");
  expect(await Bun.file(located().brief).text()).toContain(
    "The worktree `` is at the PR head `` on the local branch ``.",
  );
  expect(readRequest(home.paths).request).toMatchObject({
    launchState: "interrupted",
    sync: null,
    ownerPid: null,
  });
});

test("a failed move keeps the sync and shows the failure, and nothing is prompted", async () => {
  const events = watchHold();
  spyOn(WorkerDispatch, "moveReviewer").mockReturnValue(
    ErrAsync({ reason: "review_fetch_failed", detail: "No remote." }),
  );
  const prompted = spyOn(Herdr, "prompt");
  const snapshot = held({ ...running, sync: head });
  expect(await syncReviewer(home.paths, target, snapshot)).toMatchObject({
    tag: "Err",
    error: { reason: "review_fetch_failed", detail: "No remote." },
  });
  expect(readRequest(home.paths).request).toMatchObject({
    sync: head,
    failureReason: "review_fetch_failed",
    failureDetail: "No remote.",
    launchState: "running",
    ownerPid: null,
  });
  expect(prompted).not.toHaveBeenCalled();
  expect(events).toEqual(["hold r1", "release r1"]);
});

test("a move that stops is a defect, and a lost lease wins over the move failure", async () => {
  spyOn(WorkerDispatch, "moveReviewer").mockReturnValue(defect(new Error("crash")));
  expect(await syncReviewer(home.paths, target, held({ ...running, sync: head }))).toMatchObject({
    tag: "Err",
    error: { reason: "review_defect", detail: "Error: crash" },
  });
  expect(readRequest(home.paths).request?.failureDetail).toBe("Error: crash");
  const lost = held({ ...running, sync: head, ownerPid: process.pid + 1 });
  expect(await syncReviewer(home.paths, target, lost)).toMatchObject({
    tag: "Err",
    error: { reason: "review_lease_lost" },
  });
});

test("a request that ended during the sync is not finished on the next open request", async () => {
  const prompted = spyOn(Herdr, "prompt").mockReturnValue(OkAsync(null));
  const sync = JSON.stringify({ kind: "round", round: 2, trigger: "reply" });
  const ended = held({ ...running, sync });
  held({ state: "closed", endedAt: new Date().toISOString() });
  seedRequest(home.paths, { ...running, name: "reviewer-2", sync, ownerPid: process.pid }, "r2");
  expect(await syncReviewer(home.paths, target, ended)).toMatchObject({
    tag: "Err",
    error: { reason: "review_lease_lost" },
  });
  expect(prompted).toHaveBeenCalledTimes(1);
  const moved = spyOn(WorkerDispatch, "moveReviewer").mockReturnValue(
    ErrAsync({ reason: "review_fetch_failed", detail: "No remote." }),
  );
  expect(
    await syncReviewer(home.paths, target, {
      ...ended,
      request: ended.request && { ...ended.request, sync: head },
    }),
  ).toMatchObject({ tag: "Err", error: { reason: "review_lease_lost" } });
  expect(moved).toHaveBeenCalledTimes(1);
  expect(readRequest(home.paths, "r2").request).toMatchObject({
    sync,
    failureReason: null,
    launchState: "running",
    ownerPid: process.pid,
  });
});

test("a brief that cannot be written is an I/O failure, and the hold is released", async () => {
  const events = watchHold();
  const prompted = spyOn(Herdr, "prompt");
  const sync = JSON.stringify({ kind: "round", round: 2, trigger: "reply" });
  const snapshot = held({ ...running, sync }, [round(1, "posted")]);
  await mkdir(located().directory, { recursive: true });
  await Bun.write(located().rounds, "not a folder");
  expect(await syncReviewer(home.paths, target, snapshot)).toMatchObject({
    tag: "Err",
    error: { reason: "review_io_failed" },
  });
  expect(prompted).not.toHaveBeenCalled();
  expect(events).toEqual(["hold r1", "release r1"]);
});

function closed(change: Partial<Omit<Row, "id">> = {}) {
  return held({
    state: "closed",
    launchState: "running",
    name: "reviewer",
    paneId: "p1",
    herdrSocket: "/s",
    cleanupState: "pending",
    ...change,
  });
}

async function cleaned(snapshot: Snapshot) {
  return cleanupReviewer(home.paths, target, snapshot);
}

test("a cleanup with no request or project is a defect", async () => {
  const snapshot = closed();
  const lost = { reason: "review_defect", detail: "The cleanup lost its request." };
  expect(await cleaned({ ...snapshot, request: null })).toMatchObject({ tag: "Err", error: lost });
  expect(await cleaned({ ...snapshot, project: null })).toMatchObject({ tag: "Err", error: lost });
});

test("a cleanup with no pane and no worktree is done, recorded, and releases the request", async () => {
  const events = watchHold();
  const outcome = { state: "done", detail: "No reviewer pane was recorded." };
  expect(await cleaned(closed({ paneId: null }))).toMatchObject({ tag: "Ok", value: outcome });
  expect(readRequest(home.paths).request).toMatchObject({
    cleanupState: "done",
    cleanupDetail: outcome.detail,
    ownerPid: null,
  });
  expect(events).toEqual(["hold r1", "release r1"]);
});

test("a pane of another Herdr server is not closed", async () => {
  socket("/other");
  const listed = spyOn(Herdr, "agentNames");
  expect(await cleaned(closed())).toMatchObject({
    tag: "Ok",
    value: {
      state: "failed",
      detail:
        "Pane p1 belongs to another Herdr server. Run operator review cleanup in a pane of that server.",
    },
  });
  expect(readRequest(home.paths).request?.cleanupState).toBe("failed");
  expect(listed).not.toHaveBeenCalled();
});

test("a pane with no recorded server is closed only outside any server", async () => {
  socket(undefined);
  spyOn(Herdr, "agentNames").mockReturnValue(OkAsync(["someone", "reviewer"]));
  const close = spyOn(Herdr, "closePane").mockReturnValue(OkAsync("closed" as const));
  expect(await cleaned(closed({ herdrSocket: null }))).toMatchObject({
    tag: "Ok",
    value: { state: "done", detail: "Closed pane p1." },
  });
  expect(close).toHaveBeenCalledWith("p1");
});

test("a failed agent list or pane close fails the cleanup with its cause", async () => {
  socket("/s");
  const listed = spyOn(Herdr, "agentNames").mockReturnValue(
    ErrAsync({ reason: "herdr_failed" as const, detail: "list refused" }),
  );
  expect(await cleaned(closed())).toMatchObject({
    tag: "Ok",
    value: { state: "failed", detail: "list refused" },
  });
  listed.mockReturnValue(defect(new Error("list crash")));
  expect(await cleaned(closed())).toMatchObject({
    tag: "Ok",
    value: { state: "failed", detail: "Error: list crash" },
  });
  listed.mockReturnValue(OkAsync(["someone", "reviewer"]));
  const close = spyOn(Herdr, "closePane").mockReturnValue(
    ErrAsync({ reason: "herdr_failed" as const, detail: "close refused" }),
  );
  const cleanWorktree = spyOn(WorkerDispatch, "cleanWorktree");
  expect(await cleaned(closed({ worktreePath: "/w" }))).toMatchObject({
    tag: "Ok",
    value: { state: "failed", detail: "close refused" },
  });
  close.mockReturnValue(defect(new Error("close crash")));
  expect(await cleaned(closed())).toMatchObject({
    tag: "Ok",
    value: { state: "failed", detail: "Error: close crash" },
  });
  expect(cleanWorktree).not.toHaveBeenCalled();
});

test("a pane that no longer holds the reviewer is left open", async () => {
  socket("/s");
  spyOn(Herdr, "agentNames").mockReturnValue(OkAsync(["someone"]));
  const close = spyOn(Herdr, "closePane");
  expect(await cleaned(closed())).toMatchObject({
    tag: "Ok",
    value: { state: "done", detail: "Pane p1 no longer holds reviewer." },
  });
  expect(await cleaned(closed({ name: null }))).toMatchObject({
    tag: "Ok",
    value: { state: "done", detail: "Pane p1 no longer holds the reviewer." },
  });
  expect(close).not.toHaveBeenCalled();
});

test("the worktree goes after the pane, and kept work stays visible", async () => {
  socket("/s");
  spyOn(Herdr, "agentNames").mockReturnValue(OkAsync(["someone", "reviewer"]));
  spyOn(Herdr, "closePane").mockReturnValue(OkAsync("closed" as const));
  const clean = spyOn(WorkerDispatch, "cleanWorktree").mockResolvedValue({
    state: "removed",
    detail: "Removed the worktree.",
  });
  expect(await cleaned(closed({ worktreePath: "/w", branch: "review/b" }))).toMatchObject({
    tag: "Ok",
    value: { state: "done", detail: "Closed pane p1. Removed the worktree." },
  });
  expect(clean).toHaveBeenCalledWith({
    paths: home.paths,
    checkout: home.checkout,
    worktree: "/w",
    branch: "review/b",
  });
  clean.mockResolvedValue({ state: "kept", detail: "Kept." });
  expect(await cleaned(closed({ worktreePath: "/w" }))).toMatchObject({
    tag: "Ok",
    value: { state: "kept", detail: "Closed pane p1. Kept." },
  });
  expect(readRequest(home.paths).request).toMatchObject({
    cleanupState: "kept",
    cleanupDetail: "Closed pane p1. Kept.",
  });
  clean.mockRejectedValue(new Error("git crash"));
  expect(await cleaned(closed({ worktreePath: "/w" }))).toMatchObject({
    tag: "Ok",
    value: { state: "failed", detail: "Error: git crash" },
  });
});

test("a cleanup records the closed reviewer, so a replacement does not reopen removed work", async () => {
  socket("/s");
  spyOn(Herdr, "agentNames").mockReturnValue(OkAsync(["reviewer"]));
  spyOn(Herdr, "closePane").mockReturnValue(OkAsync("closed" as const));
  const clean = spyOn(WorkerDispatch, "cleanWorktree").mockResolvedValue({
    state: "removed",
    detail: "Removed the worktree.",
  });
  const approved = { state: "approved", worktreePath: "/w", branch: "review/b" };
  for (const launchState of ["running", "starting"]) {
    await cleaned(closed({ ...approved, launchState }));
    expect(readRequest(home.paths).request).toMatchObject({
      state: "approved",
      cleanupState: "done",
      launchState: "interrupted",
      worktreePath: null,
      branch: null,
    });
  }
  // A stopped reviewer keeps its launch state.
  await cleaned(closed({ ...approved, launchState: "failed" }));
  expect(readRequest(home.paths).request?.launchState).toBe("failed");
  // Kept work stays recorded, so a replacement reuses it.
  clean.mockResolvedValue({ state: "kept", detail: "Kept." });
  await cleaned(closed({ ...approved, launchState: "running" }));
  expect(readRequest(home.paths).request).toMatchObject({
    cleanupState: "kept",
    launchState: "interrupted",
    worktreePath: "/w",
    branch: "review/b",
  });
  // A failed cleanup changes no reviewer field.
  clean.mockRejectedValue(new Error("git crash"));
  await cleaned(closed({ ...approved, launchState: "running" }));
  expect(readRequest(home.paths).request).toMatchObject({
    cleanupState: "failed",
    launchState: "running",
    worktreePath: "/w",
    branch: "review/b",
  });
});

test("a cleanup whose request another process took records nothing", async () => {
  socket("/s");
  const other = { ownerPid: process.pid + 1, leaseAt: new Date().toISOString() };
  spyOn(Herdr, "agentNames").mockImplementation(() => {
    DeviceState.changeReviewRequest(home.paths, { ...target, id: "r1" }, () =>
      Ok({ update: other }),
    );
    return OkAsync(["someone"]);
  });
  spyOn(WorkerDispatch, "cleanWorktree").mockResolvedValue({ state: "removed", detail: "Gone." });
  const snapshot = closed({ state: "approved", worktreePath: "/w", branch: "review/b" });
  expect<unknown>(await cleaned(snapshot)).toEqual({
    tag: "Err",
    error: {
      reason: "review_lease_lost",
      detail: "Another process took this review request. Nothing more was recorded.",
    },
  });
  expect(readRequest(home.paths).request).toMatchObject({
    ...other,
    cleanupState: "pending",
    launchState: "running",
    worktreePath: "/w",
    branch: "review/b",
  });
});

test("a cleanup that stops records nothing and releases the hold", async () => {
  const events = watchHold();
  socket("/s");
  const listed = spyOn(Herdr, "agentNames").mockImplementation(() =>
    defect<string[]>(new Error("unused")),
  );
  listed.mockRejectedValueOnce(Object.assign(new Error("disk"), { code: "EIO" }));
  expect(await cleaned(closed())).toMatchObject({
    tag: "Err",
    error: { reason: "review_io_failed", detail: "Error: disk" },
  });
  listed.mockRejectedValueOnce("not an error");
  expect((await cleaned(closed())).tag).toBe("Defect");
  expect(readRequest(home.paths).request?.cleanupState).toBe("pending");
  expect(events).toEqual(["hold r1", "release r1", "hold r1", "release r1"]);
});

test("a cleanup is claimed only when work is left and no other process runs it", () => {
  const unchanged = {
    tag: "Err",
    error: { reason: "review_cleanup_unchanged", detail: "The reviewer cleanup is done." },
  };
  for (const cleanupState of [null, "done"]) {
    held({ state: "closed", cleanupState, ownerPid: null, leaseAt: null });
    expect(claimCleanup(home.paths, target, "r1")).toMatchObject(unchanged);
  }
  held({ state: "approved", cleanupState: "done", ownerPid: null, leaseAt: null });
  expect(claimCleanup(home.paths, target, "r1")).toMatchObject(unchanged);
  // An earlier Operator version kept the reviewer of an approved request and recorded no cleanup.
  held({ state: "approved", cleanupState: null, ownerPid: null, leaseAt: null });
  expect(claimCleanup(home.paths, target, "r1")).toMatchObject({
    tag: "Ok",
    value: { request: { ownerPid: process.pid, cleanupState: "pending" } },
  });
  expect(claimCleanup(home.paths, target, "missing")).toMatchObject(unchanged);
  held({ state: "closed", cleanupState: "failed" });
  expect(claimCleanup(home.paths, target, "r1")).toMatchObject({
    tag: "Err",
    error: {
      reason: "review_cleanup_in_progress",
      detail: "Another process cleans up this reviewer now. Nothing changed.",
    },
  });
  // The claim records the cleanup as pending, so a renewal waits and a wait resumes a stop.
  held({ state: "closed", cleanupState: "failed", ownerPid: null, leaseAt: null });
  expect(claimCleanup(home.paths, target, "r1")).toMatchObject({
    tag: "Ok",
    value: { request: { ownerPid: process.pid, cleanupState: "pending" } },
  });
});
