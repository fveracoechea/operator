import { afterAll, expect, jest, test } from "bun:test";
import { Database } from "bun:sqlite";
import { Ok } from "unthrown";
// Bun has no temporary-directory, listing, mode, symlink, or recursive removal API.
import { chmod, mkdtemp, readdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Environment } from "../environment/main.ts";
import { OperatorHome } from "../operator-home/main.ts";
import { DeviceState } from "./main.ts";

// Root ignores file modes, so a test of a denied access cannot run as root.
const asRoot = process.getuid?.() === 0;

const root = await mkdtemp(path.join(tmpdir(), "operator-state-"));
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

test("only registration creates state and lookup remains project-scoped", async () => {
  const paths = OperatorHome.resolve(Environment.parse({ HOME: root, NODE_ENV: "test" }));
  expect(DeviceState.checkCompatibility(paths)).toMatchObject({
    tag: "Err",
    error: { reason: "state_missing" },
  });
  expect(DeviceState.checkCompatibility(paths, true).tag).toBe("Ok");
  expect(DeviceState.readSources(paths, "owner/one")).toMatchObject({
    tag: "Err",
    error: { reason: "state_missing" },
  });
  expect(
    DeviceState.registerSource(
      paths,
      "/isolated/one",
      {
        id: "one",
        repository: "owner/one",
        trackerKey: "APP-1",
        state: "open",
        registeredAt: "now",
        endedAt: null,
        plan: "{}",
      },
      [],
    ),
  ).toMatchObject({ tag: "Err", error: { reason: "state_missing" } });
  expect(DeviceState.lookupProject(paths, "/isolated/one", [])).toMatchObject({
    tag: "Err",
    error: { reason: "state_missing" },
  });
  expect(await Bun.file(paths.database).exists()).toBe(false);
  for (const name of ["one", "two"])
    expect(
      DeviceState.registerProject(paths, {
        repository: `owner/${name}`,
        checkout: `/isolated/${name}`,
        registeredAt: "now",
      }).tag,
    ).toBe("Ok");
  expect(DeviceState.lookupProject(paths, "/isolated/one", ["owner/one"])).toMatchObject({
    tag: "Ok",
    value: { controller: { repository: "owner/one" }, matches: [{ repository: "owner/one" }] },
  });
  expect(DeviceState.checkCompatibility(paths).tag).toBe("Ok");
  expect(
    DeviceState.registerSource(
      paths,
      "/isolated/one",
      {
        id: "one",
        repository: "owner/one",
        trackerKey: "APP-1",
        state: "finished",
        registeredAt: "now",
        endedAt: "now",
        plan: "{}",
      },
      [],
    ).tag,
  ).toBe("Ok");
  expect(DeviceState.readSources(paths, "owner/one", "one")).toMatchObject({
    tag: "Ok",
    value: [{ source: { id: "one" }, assignments: [] }],
  });
  expect(DeviceState.listProjects(paths)).toMatchObject({
    tag: "Ok",
    value: {
      projects: [
        { repository: "owner/one", openSources: 0 },
        { repository: "owner/two", openSources: 0 },
      ],
    },
  });
  expect(DeviceState.moveProject(paths, "owner/one", "/isolated/moved")).toMatchObject({
    tag: "Ok",
    value: { data: { checkout: "/isolated/moved" } },
  });
  expect(DeviceState.removeProject(paths, "owner/one")).toMatchObject({
    tag: "Ok",
    value: { reason: "project_removed" },
  });
  expect(DeviceState.listProjects(paths)).toMatchObject({
    tag: "Ok",
    value: { projects: [{ repository: "owner/two" }], pendingRemovals: [] },
  });
  await rm(paths.database);
  expect(DeviceState.lookupProject(paths, "/isolated/one", ["owner/one"])).toMatchObject({
    tag: "Err",
    error: { reason: "state_missing" },
  });
  expect(await Bun.file(paths.database).exists()).toBe(false);
});

async function home(name: string) {
  const base = await mkdtemp(path.join(root, `${name}-`));
  return OperatorHome.resolve(Environment.parse({ HOME: base, NODE_ENV: "test" }));
}

const one = { repository: "owner/one", checkout: "/isolated/one", registeredAt: "now" };
const openSource = {
  id: "s1",
  repository: "owner/one",
  trackerKey: "APP-1",
  state: "open",
  registeredAt: "now",
  endedAt: null,
  plan: "{}",
};
function launchRow(id: string, assignment: string) {
  return {
    id,
    sourceId: "s1",
    assignment,
    state: "starting",
    name: `launch-${id}`,
    resources: "worktree",
    branch: `task/${assignment}`,
    host: "opencode",
    model: "m",
    requestedModel: "m",
    reasoningEffort: "medium",
    profile: null,
    release: "{}",
    skills: "[]",
    herdrSocket: "/herdr.sock",
    workspaceId: null,
    tabId: null,
    paneId: null,
    worktreePath: null,
    worktreeWorkspaceId: null,
    startedAt: "now",
    endedAt: null,
    failureReason: null,
    failureDetail: null,
    activity: null,
    activityAt: null,
  };
}

async function registered(name: string) {
  const paths = await home(name);
  expect(DeviceState.registerProject(paths, one)).toMatchObject({
    tag: "Ok",
    value: { reason: "project_registered", data: one },
  });
  expect(
    DeviceState.registerSource(paths, one.checkout, openSource, [
      { sourceId: "s1", key: "change", completion: "pr", state: "ready" },
      { sourceId: "s1", key: "read", completion: "report", state: "ready" },
    ]),
  ).toMatchObject({ tag: "Ok", value: openSource });
  return paths;
}

test("missing state refuses each operation with its own detail and writes nothing", async () => {
  const paths = await home("missing");
  function missing(detail: string) {
    return { tag: "Err", error: { reason: "state_missing", detail } };
  }
  const operation = missing("Register the project explicitly before this operation.");
  expect(DeviceState.launchNames(paths)).toMatchObject(operation);
  expect(DeviceState.readReviewRequests(paths)).toMatchObject(operation);
  expect(DeviceState.startSlackWatch(paths, "C1", "1.0")).toMatchObject(operation);
  expect(DeviceState.registerSource(paths, one.checkout, openSource, [])).toMatchObject(
    missing("Register the project explicitly before registering a source."),
  );
  expect(DeviceState.readSources(paths, "owner/one")).toMatchObject(
    missing("Register the project explicitly before reading sources."),
  );
  expect(DeviceState.lookupProject(paths, one.checkout, [])).toMatchObject(
    missing(
      "The device database is missing. Run operator project register explicitly in the controlling checkout.",
    ),
  );
  expect(DeviceState.listProjects(paths)).toMatchObject(operation);
  expect(DeviceState.moveProject(paths, "owner/one", "/moved")).toMatchObject(operation);
  expect(DeviceState.removeProject(paths, "owner/one")).toMatchObject(operation);
  expect(await Bun.file(paths.database).exists()).toBe(false);
  // A linked database is unsupported state, never adopted.
  await Bun.write(`${paths.stateRoot}/elsewhere.sqlite`, "", { createPath: true });
  await symlink(`${paths.stateRoot}/elsewhere.sqlite`, paths.database);
  expect(DeviceState.launchNames(paths)).toMatchObject({
    tag: "Err",
    error: { reason: "state_incompatible" },
  });
  const linked = DeviceState.registerProject(paths, one);
  expect(linked).toMatchObject({ tag: "Err", error: { reason: "state_incompatible" } });
  if (linked.tag === "Err")
    expect(linked.error.detail).toBe(
      "Error: The device database must be a regular file, not a link or directory.",
    );
});

test("registration creates the project folder, and a repeat registers in the existing database", async () => {
  const paths = await registered("register");
  expect(await readdir(OperatorHome.projectDirectory(paths, "owner/one"))).toEqual([]);
  expect(DeviceState.registerProject(paths, one)).toMatchObject({
    tag: "Ok",
    value: { reason: "project_unchanged" },
  });
  expect(DeviceState.registerProject(paths, { ...one, checkout: "/elsewhere" })).toMatchObject({
    tag: "Err",
    error: { reason: "controller_mismatch" },
  });
  expect(DeviceState.moveProject(paths, "owner/one", "/isolated/moved")).toMatchObject({
    tag: "Err",
    error: { reason: "project_source_open" },
  });
  expect(DeviceState.removeProject(paths, "owner/one")).toMatchObject({
    tag: "Err",
    error: { reason: "project_source_open" },
  });
  expect(DeviceState.listProjects(paths)).toMatchObject({
    tag: "Ok",
    value: { projects: [{ repository: "owner/one", openSources: 1 }], pendingRemovals: [] },
  });
});

test.skipIf(asRoot)(
  "a removal whose file cleanup fails keeps the cleanup pending with its cause",
  async () => {
    const paths = await home("remove");
    expect(DeviceState.registerProject(paths, one).tag).toBe("Ok");
    const directory = OperatorHome.projectDirectory(paths, "owner/one");
    await Bun.write(`${directory}/inner/report`, "kept", { createPath: true });
    await chmod(`${directory}/inner`, 0o500);
    let removed;
    try {
      removed = DeviceState.removeProject(paths, "owner/one");
    } finally {
      await chmod(`${directory}/inner`, 0o700);
    }
    expect(removed).toMatchObject({ tag: "Err", error: { reason: "project_cleanup_pending" } });
    if (removed.tag === "Err")
      expect(removed.error.detail).toStartWith(
        "Project records were removed, but file cleanup is still pending. Repeat project remove owner/one --person-instructed after resolving the path or I/O failure. Error: ENOTEMPTY",
      );
    expect(DeviceState.listProjects(paths)).toMatchObject({
      value: { projects: [], pendingRemovals: [{ repository: "owner/one" }] },
    });
    expect(DeviceState.removeProject(paths, "owner/one")).toMatchObject({
      tag: "Ok",
      value: { reason: "project_removed", data: { repository: "owner/one" } },
    });
    expect(await Bun.file(`${directory}/inner/report`).exists()).toBe(false);
  },
);

test("each interface operation reaches its state owner on the registered database", async () => {
  const paths = await registered("operations");
  expect(
    DeviceState.reserveLaunch(paths, one.checkout, "owner/one", launchRow("l1", "change")),
  ).toMatchObject({
    tag: "Ok",
    value: { attempt: 1 },
  });
  expect(
    DeviceState.updateLaunch(paths, "l1", {
      paneId: "p1",
      worktreePath: "/worktrees/change",
      state: "running",
    }),
  ).toMatchObject({ tag: "Ok", value: { state: "running" } });
  DeviceState.reserveLaunch(paths, one.checkout, "owner/one", launchRow("l2", "read"));
  DeviceState.updateLaunch(paths, "l2", { paneId: "p2", state: "running" });
  expect(DeviceState.launchNames(paths)).toMatchObject({
    tag: "Ok",
    value: ["launch-l1", "launch-l2"],
  });
  expect(DeviceState.worktreeOwners(paths)).toMatchObject({
    tag: "Ok",
    value: [{ launchId: "l1" }],
  });
  expect(
    DeviceState.observePane(paths, {
      socket: "/herdr.sock",
      paneId: "p1",
      workspaceId: null,
      observation: { exited: false, activity: "busy" },
    }),
  ).toMatchObject({ tag: "Ok", value: { launches: ["l1"] } });
  const pane = { by: "pane", socket: "/herdr.sock", paneId: "p2" } as const;
  expect(DeviceState.readReport(paths, pane)).toMatchObject({
    tag: "Ok",
    value: { assignment: { key: "read" } },
  });
  expect(
    DeviceState.changeReport(paths, pane, () => Ok({ assignmentState: "reported" })),
  ).toMatchObject({ tag: "Ok", value: { change: { assignmentState: "reported" } } });
  const pr = {
    number: 7,
    url: "https://github.com/owner/one/pull/7",
    branch: "task/change",
    relay: null,
  };
  expect(DeviceState.associatePullRequest(paths, "l1", pr, true)).toMatchObject({
    tag: "Ok",
    value: { changed: true },
  });
  expect(DeviceState.readReviewRequests(paths)).toMatchObject({
    tag: "Ok",
    value: [{ request: { origin: "assignment", number: 7 } }],
  });
  const target = { repository: "owner/one", number: 7 };
  expect(DeviceState.readReviewRequest(paths, target)).toMatchObject({
    tag: "Ok",
    value: { request: { state: "queued" } },
  });
  expect(
    DeviceState.changeReviewRequest(paths, target, () => Ok({ update: { state: "reviewing" } })),
  ).toMatchObject({ tag: "Ok", value: { request: { state: "reviewing" } } });
  expect(
    DeviceState.recordPullRequestWait(paths, "l1", (row) => ({
      progress: row.progress,
      waitState: "waiting",
    })),
  ).toMatchObject({ tag: "Ok", value: { waitState: "waiting", waitOwnerPid: process.pid } });
  expect(DeviceState.beginPreparation(paths, "/wt", "owner/one")).toMatchObject({
    tag: "Ok",
    value: { state: "running" },
  });
  expect(
    DeviceState.finishPreparation(paths, "/wt", { state: "prepared", detail: "ok" }),
  ).toMatchObject({
    tag: "Ok",
    value: { state: "prepared" },
  });
  expect(DeviceState.readPreparation(paths, "/wt")).toMatchObject({
    tag: "Ok",
    value: { state: "prepared", abandoned: false },
  });
  expect(DeviceState.startSlackWatch(paths, "C1", "10.000000").tag).toBe("Ok");
  expect(
    DeviceState.ingestSlack(paths, {
      channel: "C1",
      from: { cursor: "10.000000", latest: null, pending: null },
      to: { cursor: "20.000000", latest: null, pending: null, paging: false },
      candidates: [
        {
          repository: "owner/one",
          number: 9,
          url: "https://github.com/owner/one/pull/9",
          threadTs: "11.000000",
        },
      ],
      start: [{ key: "reaction:eyes", kind: "reaction", content: "eyes" }],
    }),
  ).toMatchObject({ tag: "Ok", value: [{ outcome: "recorded" }] });
  const slack = DeviceState.readSlack(paths, "C1");
  expect(slack).toMatchObject({
    tag: "Ok",
    value: { watch: { cursor: "20.000000" }, effects: [{ kind: "reaction" }] },
  });
  const effect = slack.tag === "Ok" ? (slack.value.effects[0]?.id ?? "") : "";
  expect(
    DeviceState.acknowledgeSlackEffect(paths, effect, () => ({ kind: "done", slackTs: null })),
  ).toMatchObject({ tag: "Ok", value: { changed: true, effect: { state: "done" } } });
  expect(
    DeviceState.recordPullRequestMerge(
      paths,
      "l1",
      { number: 7, head: "h", mergeCommit: "m" },
      () => "open",
    ),
  ).toMatchObject({ tag: "Ok", value: { changed: true } });
  expect(DeviceState.startCleanup(paths, "s1", "change", process.pid).tag).toBe("Ok");
  expect(DeviceState.claimCleanup(paths, "owner/one", "s1", "change")).toMatchObject({
    tag: "Ok",
    value: { cleanup: { ownerPid: process.pid } },
  });
  expect(
    DeviceState.advanceCleanup(paths, "s1", "change", {
      step: null,
      state: "done",
      reason: null,
      detail: null,
      release: true,
    }).tag,
  ).toBe("Ok");
  expect(DeviceState.readSources(paths, "owner/one", "s1")).toMatchObject({
    tag: "Ok",
    value: [{ cleanups: [{ state: "done", running: false }] }],
  });
  expect(
    DeviceState.resetSource(
      paths,
      { repository: "owner/one", checkout: one.checkout, sourceId: "s1" },
      () => Ok({ abandon: ["read"] }),
    ),
  ).toMatchObject({ tag: "Ok", value: { source: { state: "reset" } } });
  expect(
    DeviceState.pruneSource(
      paths,
      { repository: "owner/one", checkout: one.checkout, sourceId: "s1" },
      () => false,
    ),
  ).toMatchObject({ tag: "Ok", value: null });
  expect(DeviceState.lookupProject(paths, one.checkout, ["owner/one"])).toMatchObject({
    tag: "Ok",
    value: { controller: { repository: "owner/one" } },
  });
});

test("each hold renews its lease on the renewal interval until it stops", async () => {
  const paths = await registered("holds");
  DeviceState.reserveLaunch(paths, one.checkout, "owner/one", launchRow("l1", "change"));
  DeviceState.beginPreparation(paths, "/wt", "owner/one");
  DeviceState.updateLaunch(paths, "l1", { worktreePath: "/w", state: "running" });
  DeviceState.associatePullRequest(paths, "l1", {
    number: 7,
    url: "u",
    branch: "task/change",
    relay: JSON.stringify({ ownerPid: process.pid, leaseAt: null }),
  });
  // An association asks for no review unless the caller says so.
  expect(DeviceState.readReviewRequests(paths)).toMatchObject({ tag: "Ok", value: [] });
  DeviceState.changeReviewRequest(paths, { repository: "owner/one", number: 7 }, () =>
    Ok({
      insert: {
        id: "r1",
        repository: "owner/one",
        number: 7,
        url: "u",
        origin: "slack",
        state: "queued",
      },
      lease: "hold" as const,
    }),
  );
  DeviceState.recordPullRequestWait(paths, "l1", (row) => ({
    progress: row.progress,
    waitState: "waiting",
  }));
  DeviceState.recordPullRequestMerge(
    paths,
    "l1",
    { number: 7, head: "h", mergeCommit: "m" },
    () => "open",
  );
  DeviceState.claimCleanup(paths, "owner/one", "s1", "change");
  // The launch must still be starting for its renewal.
  using db = new Database(paths.database);
  db.exec(
    "UPDATE launches SET state = 'starting'; UPDATE pull_requests SET wait_state = 'waiting'",
  );
  const old = "2000-01-01T00:00:00.000Z";
  function age() {
    return db
      .query(
        `SELECT
          (SELECT lease_at FROM launches) > '2001' AS launch,
          (SELECT lease_at FROM worktree_preparations) > '2001' AS preparation,
          (SELECT lease_at FROM review_requests) > '2001' AS review,
          (SELECT wait_lease_at FROM pull_requests) > '2001' AS wait,
          (SELECT json_extract(relay, '$.leaseAt') FROM pull_requests) > '2001' AS relay,
          (SELECT lease_at FROM cleanups) > '2001' AS cleanup`,
      )
      .get();
  }
  function aged(fresh: number) {
    return {
      launch: fresh,
      preparation: fresh,
      review: fresh,
      wait: fresh,
      relay: fresh,
      cleanup: fresh,
    };
  }
  function reset() {
    db.exec(
      `UPDATE launches SET lease_at = '${old}'; UPDATE worktree_preparations SET lease_at = '${old}'; UPDATE review_requests SET lease_at = '${old}'; UPDATE pull_requests SET wait_lease_at = '${old}', relay = json_set(relay, '$.leaseAt', '${old}'); UPDATE cleanups SET lease_at = '${old}'`,
    );
  }
  reset();
  jest.useFakeTimers();
  try {
    const stops = [
      DeviceState.holdLaunch(paths, "l1"),
      DeviceState.holdPreparation(paths, "/wt"),
      DeviceState.holdReviewRequest(paths, "r1"),
      DeviceState.holdPullRequestWait(paths, "s1", "change"),
      DeviceState.holdPullRequestRelay(paths, "s1", "change"),
      DeviceState.holdCleanup(paths, "s1", "change"),
    ];
    jest.advanceTimersByTime(14999);
    expect(age()).toEqual(aged(0));
    jest.advanceTimersByTime(1);
    expect(age()).toEqual(aged(1));
    for (const stop of stops) stop();
    reset();
    jest.advanceTimersByTime(30000);
    expect(age()).toEqual(aged(0));
  } finally {
    jest.useRealTimers();
  }
});

test("a hold that is never stopped does not keep its process alive", async () => {
  const paths = await home("unref");
  const script = `import { DeviceState } from ${JSON.stringify(Bun.fileURLToPath(new URL("./main.ts", import.meta.url)))};
DeviceState.holdLaunch(${JSON.stringify(paths)}, "l1");`;
  const child = Bun.spawn([process.execPath, "-e", script], { stdout: "ignore", stderr: "ignore" });
  const exited = await Promise.race([child.exited, Bun.sleep(5000).then(() => "running")]);
  child.kill();
  expect(exited).toBe(0);
});
