import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
// Bun has no temporary-directory, folder creation, or recursive removal API.
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Err, fromThrowable, Ok, OkAsync } from "unthrown";
import { DeviceState } from "../device-state/main.ts";
import { Environment } from "../environment/main.ts";
import { OperatorHome } from "../operator-home/main.ts";
import { Projects } from "../projects/main.ts";
import { Herdr } from "../herdr/main.ts";
import { WorkSources } from "./main.ts";
import { z } from "zod";

const day = 24 * 60 * 60 * 1000;
let root = "";
let checkout = "";
let paths: ReturnType<typeof OperatorHome.resolve>;
beforeEach(async () => {
  root = await realpath(await mkdtemp(path.join(tmpdir(), "operator-source-lifecycle-")));
  paths = OperatorHome.resolve(Environment.parse({ HOME: `${root}/home`, NODE_ENV: "test" }));
  checkout = `${root}/checkout`;
  await mkdir(checkout);
  for (const args of [
    ["init", "-q"],
    ["remote", "add", "origin", "https://github.com/example/one.git"],
  ])
    expect(await Bun.spawn(["git", ...args], { cwd: checkout, stderr: "pipe" }).exited).toBe(0);
  expect((await Projects.register({ paths, cwd: checkout })).tag).toBe("Ok");
});
afterEach(async () => {
  mock.restore();
  await rm(root, { recursive: true, force: true });
});

function assignment(key: string, completion: "pr" | "report" = "report") {
  return completion === "pr"
    ? {
        key,
        trackerKey: `APP-${key}`,
        instructions: `Do ${key}.`,
        completion,
        resources: "worktree",
        branch: `task/${key}`,
        dependencies: [],
      }
    : {
        key,
        trackerKey: `APP-${key}`,
        instructions: `Do ${key}.`,
        completion,
        resources: "pane",
        dependencies: [],
      };
}

async function register(plan: Record<string, unknown>) {
  const file = `${root}/plan-${crypto.randomUUID()}.json`;
  await Bun.write(file, JSON.stringify(plan));
  return WorkSources.register({ paths, cwd: checkout, file });
}

async function registered(keys: string[], trackerKey = "APP-1") {
  const result = await register({
    trackerKey,
    assignments: keys.map((key) => assignment(key)),
  });
  expect(result.tag).toBe("Ok");
  return result.tag === "Ok" ? result.value.id : "";
}

/** Set an assignment state through the report transaction of device state. */
function setState(sourceId: string, key: string, state: string) {
  const changed = DeviceState.changeReport(
    paths,
    { by: "key", repository: "example/one", checkout, sourceId, assignment: key },
    () => Ok({ assignmentState: state }),
  );
  expect(changed.tag).toBe("Ok");
}

function launch(sourceId: string, key: string, state: "running" | "failed") {
  const id = crypto.randomUUID();
  expect(
    DeviceState.reserveLaunch(paths, checkout, "example/one", {
      id,
      sourceId,
      assignment: key,
      state: "starting",
      name: `worker-${key}-${id}`,
      resources: "worktree",
      branch: `task/${key}`,
      host: "opencode",
      model: "test/model",
      requestedModel: "test/model",
      reasoningEffort: "medium",
      profile: null,
      release: JSON.stringify({ version: "1.0.0" }),
      skills: "[]",
      herdrSocket: "/herdr.sock",
      workspaceId: "w1",
      tabId: "w1:t1",
      paneId: null,
      worktreePath: `${root}/worktrees/${key}`,
      worktreeWorkspaceId: null,
      startedAt: new Date().toISOString(),
      endedAt: null,
      failureReason: null,
      failureDetail: null,
      activity: null,
      activityAt: null,
    }).tag,
  ).toBe("Ok");
  expect(DeviceState.updateLaunch(paths, id, { state, paneId: `w1:${key}` }).tag).toBe("Ok");
  return id;
}

function reset(sourceId: string, personInstructed = true) {
  return WorkSources.reset({ paths, cwd: checkout, sourceId, personInstructed });
}

async function shown(sourceId: string) {
  const result = await WorkSources.show({ paths, cwd: checkout, sourceId });
  return result.tag === "Ok" ? result.value : undefined;
}

test("registration stores a supplied plan with ready assignments and no tracker reads", async () => {
  const plan = { trackerKey: "APP-1", assignments: [assignment("read"), assignment("fix", "pr")] };
  const result = await register(plan);
  expect(result.tag).toBe("Ok");
  if (result.tag !== "Ok") return;
  expect<unknown>(result.value).toEqual({
    id: result.value.id,
    repository: "example/one",
    trackerKey: "APP-1",
    state: "open",
    registeredAt: result.value.registeredAt,
    endedAt: null,
    plan,
    assignments: [
      { key: "read", completion: "report", state: "ready" },
      { key: "fix", completion: "pr", state: "ready" },
    ],
  });
  expect(Date.parse(result.value.registeredAt)).toBeGreaterThan(Date.now() - 60000);
  expect(await shown(result.value.id)).toMatchObject({
    state: "open",
    assignments: [
      { key: "read", state: "ready" },
      { key: "fix", state: "ready" },
    ],
  });
});

test("an empty plan registers a finished source", async () => {
  const result = await register({ trackerKey: "APP-1", assignments: [] });
  expect(result).toMatchObject({ tag: "Ok", value: { state: "finished" } });
  if (result.tag === "Ok") expect(result.value.endedAt).toBe(result.value.registeredAt);
});

test("a selected profile must exist in the device settings", async () => {
  const plan = {
    trackerKey: "APP-1",
    assignments: [{ ...assignment("read"), profile: "careful" }],
  };
  expect(await register(plan)).toMatchObject({
    tag: "Err",
    error: {
      reason: "source_profile_missing",
      detail: "The profile careful for read does not exist. No source was written.",
    },
  });
  expect((await WorkSources.next({ paths, cwd: checkout })).tag === "Ok").toBe(true);
  await Bun.write(
    paths.config,
    JSON.stringify({
      superAgent: { host: "opencode", model: "test/model" },
      profiles: { careful: { reasoningEffort: "high" } },
    }),
    { createPath: true },
  );
  expect(await register(plan)).toMatchObject({ tag: "Ok", value: { state: "open" } });
});

test("reset needs the person's instruction and changes nothing without it", async () => {
  const sourceId = await registered(["read"]);
  expect(reset(sourceId, false)).toMatchObject({
    tag: "Err",
    error: {
      reason: "person_instruction_required",
      detail:
        "Reset a source only on the person's explicit instruction. --person-instructed attests that instruction, it does not grant authority. Nothing changed.",
    },
  });
  expect(await shown(sourceId)).toMatchObject({ state: "open" });
});

test("reset keeps completed work, abandons the rest, and names retained resources", async () => {
  const sourceId = await registered(["done", "gone", "read", "stuck"]);
  setState(sourceId, "done", "completed");
  setState(sourceId, "gone", "abandoned");
  await mkdir(`${root}/worktrees/stuck`, { recursive: true });
  launch(sourceId, "stuck", "failed");
  const result = await reset(sourceId);
  expect(result.tag).toBe("Ok");
  if (result.tag !== "Ok") return;
  const endedAt = result.value.endedAt ?? "";
  expect(result.value).toEqual({
    id: sourceId,
    trackerKey: "APP-1",
    state: "reset",
    endedAt,
    prunableAt: new Date(Date.parse(endedAt) + 14 * day).toISOString(),
    preserved: ["done"],
    abandoned: ["read", "stuck"],
    retained: [
      {
        assignment: "stuck",
        worktreePath: `${root}/worktrees/stuck`,
        branch: "task/stuck",
        pullRequest: null,
      },
    ],
  });
  expect(await shown(sourceId)).toMatchObject({
    state: "reset",
    endedAt,
    assignments: [
      { key: "done", state: "completed" },
      { key: "gone", state: "abandoned" },
      { key: "read", state: "abandoned" },
      { key: "stuck", state: "abandoned" },
    ],
  });
  expect(await reset(sourceId)).toMatchObject({
    tag: "Err",
    error: { reason: "source_ended", detail: "The source is already reset. Nothing changed." },
  });
});

test("reset refuses a running worker and corrupt records", async () => {
  const sourceId = await registered(["read"]);
  launch(sourceId, "read", "running");
  expect(await reset(sourceId)).toMatchObject({
    tag: "Err",
    error: { reason: "source_worker_running" },
  });
  const original = DeviceState.resetSource;
  for (const corrupt of [
    { plan: "{broken" },
    { plan: JSON.stringify({ trackerKey: "APP-1" }) },
    { assignments: [{ sourceId, key: "read", completion: "report", state: "merged" }] },
  ]) {
    spyOn(DeviceState, "resetSource").mockImplementation((p, target, decide) =>
      original(p, target, (facts) =>
        decide({
          ...facts,
          source: { ...facts.source, plan: corrupt.plan ?? facts.source.plan },
          assignments: corrupt.assignments ?? facts.assignments,
          launches: [],
        }),
      ),
    );
    expect(await reset(sourceId)).toMatchObject({
      tag: "Err",
      error: {
        reason: "state_corrupt",
        detail: "The source assignments are invalid. They were not repaired. Nothing changed.",
      },
    });
    mock.restore();
  }
  expect(await shown(sourceId)).toMatchObject({ state: "open" });
});

test("reset retires a missing worker and preserves its unlanded work", async () => {
  const sourceId = await registered(["read"]);
  launch(sourceId, "read", "running");
  await Bun.write(`${root}/worktrees/read/uncommitted.txt`, "keep this work\n", {
    createPath: true,
  });
  spyOn(Environment, "read").mockReturnValue({
    ...Environment.read(),
    HERDR_SOCKET_PATH: "/herdr.sock",
  });
  const panes = spyOn(Herdr, "pane").mockReturnValue(OkAsync(null));
  const names = spyOn(Herdr, "agentNames").mockReturnValue(OkAsync([]));
  const closed = spyOn(Herdr, "closePane");

  expect(await reset(sourceId)).toMatchObject({
    tag: "Ok",
    value: {
      state: "reset",
      abandoned: ["read"],
      retained: [{ worktreePath: `${root}/worktrees/read`, branch: "task/read" }],
    },
  });
  expect(panes).toHaveBeenCalledWith("w1:read");
  expect(names).toHaveBeenCalledTimes(1);
  expect(closed).not.toHaveBeenCalled();
  expect(await shown(sourceId)).toMatchObject({
    assignments: [{ key: "read", state: "abandoned" }],
    launches: [{ state: "interrupted", failureReason: "pane_missing" }],
  });
  expect(await Bun.file(`${root}/worktrees/read/uncommitted.txt`).text()).toBe("keep this work\n");
});

test("a live worker prevents retirement of every missing worker", async () => {
  const sourceId = await registered(["gone", "live"]);
  launch(sourceId, "gone", "running");
  launch(sourceId, "live", "running");
  spyOn(Environment, "read").mockReturnValue({
    ...Environment.read(),
    HERDR_SOCKET_PATH: "/herdr.sock",
  });
  spyOn(Herdr, "agentNames").mockReturnValue(OkAsync([]));
  spyOn(Herdr, "pane").mockImplementation((id) =>
    OkAsync(id === "w1:gone" ? null : { tabId: "w1:t1", workspaceId: "w1" }),
  );
  const before = await shown(sourceId);
  expect(await reset(sourceId)).toMatchObject({
    tag: "Err",
    error: { reason: "source_worker_running" },
  });
  expect(await shown(sourceId)).toEqual(before);
});

test("reset includes assignments promoted after the registered plan in its ordered results", async () => {
  const sourceId = await registered(["read"]);
  const original = DeviceState.resetSource;
  spyOn(DeviceState, "resetSource").mockImplementation((p, target, decide) =>
    original(p, target, (facts) =>
      decide({
        ...facts,
        assignments: [
          { sourceId, key: "build", completion: "pr", state: "ready" },
          ...facts.assignments,
          { sourceId, key: "done", completion: "report", state: "completed" },
        ],
      }),
    ),
  );
  expect(await reset(sourceId)).toMatchObject({
    tag: "Ok",
    value: {
      state: "reset",
      preserved: ["done"],
      abandoned: ["read", "build"],
    },
  });
});

test("a changed launch identity or new worker between observation and reset stays protected", async () => {
  for (const change of ["pane", "new-launch"] as const) {
    const sourceId = await registered(["one", "two"], `APP-${change}`);
    launch(sourceId, "one", "running");
    spyOn(Environment, "read").mockReturnValue({
      ...Environment.read(),
      HERDR_SOCKET_PATH: "/herdr.sock",
    });
    spyOn(Herdr, "agentNames").mockReturnValue(OkAsync([]));
    const original = DeviceState.resetSource;
    if (change === "pane")
      spyOn(DeviceState, "resetSource").mockImplementation((p, target, decide) =>
        original(p, target, (facts) =>
          decide({
            ...facts,
            launches: facts.launches.map((worker) => ({ ...worker, paneId: "w2:p1" })),
          }),
        ),
      );
    spyOn(Herdr, "pane").mockImplementationOnce(() => {
      if (change === "new-launch") launch(sourceId, "two", "running");
      return OkAsync(null);
    });
    expect(await reset(sourceId)).toMatchObject({
      tag: "Err",
      error: { reason: "source_worker_running" },
    });
    const after = await shown(sourceId);
    expect(after).toMatchObject({ state: "open" });
    expect(after?.launches.map((worker) => [worker.state, worker.failureReason])).toEqual(
      change === "pane"
        ? [["running", null]]
        : [
            ["running", null],
            ["running", null],
          ],
    );
    mock.restore();
  }
});

test("prune deletes an ended source only after its retention", async () => {
  const open = await registered(["read"]);
  const ended = await registered(["read"], "APP-2");
  const result = await reset(ended);
  const endedAt = result.tag === "Ok" ? (result.value.endedAt ?? "") : "";
  const prunableAt = new Date(Date.parse(endedAt) + 14 * day).toISOString();
  const directory = OperatorHome.sourceDirectory(paths, {
    repository: "example/one",
    sourceId: ended,
  });
  await Bun.write(`${directory}/assignments/read/brief.md`, "brief\n");

  expect(await WorkSources.prune({ paths, cwd: checkout })).toMatchObject({
    tag: "Ok",
    value: {
      pruned: [],
      kept: [{ id: ended, state: "reset", endedAt, prunableAt, reason: "retention_pending" }],
    },
  });
  const now = Date.now();
  spyOn(Date, "now").mockReturnValue(now + 15 * day);
  expect(await WorkSources.prune({ paths, cwd: checkout })).toMatchObject({
    tag: "Ok",
    value: {
      pruned: [{ id: ended, trackerKey: "APP-2", state: "reset", endedAt, retained: [] }],
      kept: [],
    },
  });
  mock.restore();
  expect(await Bun.file(`${directory}/assignments/read/brief.md`).exists()).toBe(false);
  expect(await WorkSources.show({ paths, cwd: checkout, sourceId: ended })).toMatchObject({
    tag: "Err",
    error: { reason: "source_not_found" },
  });
  expect(await shown(open)).toMatchObject({ state: "open" });
});

test("a source that a concurrent prune removed first is kept as changed, not a failure", async () => {
  const ended = await registered(["read"]);
  await reset(ended);
  spyOn(Date, "now").mockReturnValue(Date.now() + 15 * day);
  const original = DeviceState.pruneSource;
  spyOn(DeviceState, "pruneSource").mockImplementationOnce((p, target, decide) => {
    original(p, target, decide);
    return original(p, target, decide);
  });
  expect(await WorkSources.prune({ paths, cwd: checkout })).toMatchObject({
    tag: "Ok",
    value: { pruned: [], kept: [{ id: ended, reason: "source_changed" }] },
  });
  mock.restore();
});

test("prune reports what it pruned before a failure, and a changed source stays", async () => {
  const first = await registered(["read"]);
  const second = await registered(["read"], "APP-2");
  await reset(first);
  const changed = await reset(second);
  const endedAt = changed.tag === "Ok" ? (changed.value.endedAt ?? "") : "";
  spyOn(Date, "now").mockReturnValue(Date.now() + 15 * day);
  const original = DeviceState.pruneSource;
  const prune = spyOn(DeviceState, "pruneSource");

  prune.mockImplementation((p, target, decide) =>
    target.sourceId === first
      ? original(p, target, decide)
      : Err({ reason: "source_prune_failed" as const, detail: "The folder is busy." }),
  );
  expect(await WorkSources.prune({ paths, cwd: checkout })).toMatchObject({
    tag: "Err",
    error: {
      reason: "source_prune_failed",
      detail: `Pruned ${first}. Source ${second} and its records stay, so the next prune repeats it. The folder is busy.`,
    },
  });

  prune.mockImplementation(() =>
    Err({ reason: "source_prune_failed" as const, detail: "The folder is busy." }),
  );
  expect(await WorkSources.prune({ paths, cwd: checkout })).toMatchObject({
    tag: "Err",
    error: {
      detail: `Source ${second} and its records stay, so the next prune repeats it. The folder is busy.`,
    },
  });

  prune.mockImplementation(() => Ok(null));
  expect(await WorkSources.prune({ paths, cwd: checkout })).toMatchObject({
    tag: "Ok",
    value: {
      pruned: [],
      kept: [
        {
          id: second,
          state: "reset",
          endedAt,
          prunableAt: new Date(Date.parse(endedAt) + 14 * day).toISOString(),
          reason: "source_changed",
        },
      ],
    },
  });

  prune.mockImplementation(() =>
    fromThrowable(
      () => {
        // oxlint-disable-next-line unthrown/no-throw -- Inject a defect at the device-state interface.
        throw new TypeError("state defect");
      },
      (cause, defect) => defect(cause),
    )(),
  );
  expect(await WorkSources.prune({ paths, cwd: checkout })).toMatchObject({ tag: "Defect" });
});

test("prune reads each candidate's facts again inside its own transaction", async () => {
  const sourceId = await registered(["read"]);
  await reset(sourceId);
  // The read sees an old end, but the source facts in the transaction show a recent one.
  const original = DeviceState.readSources;
  spyOn(DeviceState, "readSources").mockImplementation((p, repository, id) =>
    original(p, repository, id).map((rows) =>
      rows.map((row) => ({
        ...row,
        source: { ...row.source, endedAt: new Date(Date.now() - 15 * day).toISOString() },
      })),
    ),
  );
  expect(await WorkSources.prune({ paths, cwd: checkout })).toMatchObject({
    tag: "Ok",
    value: { pruned: [], kept: [{ id: sourceId, reason: "source_changed" }] },
  });
});

test("prune names every source it pruned before a failure", async () => {
  const ids = [
    await registered(["read"], "APP-1"),
    await registered(["read"], "APP-2"),
    await registered(["read"], "APP-3"),
  ];
  for (const id of ids) await reset(id);
  spyOn(Date, "now").mockReturnValue(Date.now() + 15 * day);
  const original = DeviceState.pruneSource;
  spyOn(DeviceState, "pruneSource").mockImplementation((p, target, decide) =>
    target.sourceId === ids[2]
      ? Err({ reason: "source_prune_failed" as const, detail: "Busy." })
      : original(p, target, decide),
  );
  const result = await WorkSources.prune({ paths, cwd: checkout });
  expect(result.tag === "Err" ? result.error.detail : null).toBe(
    `Pruned ${ids[0]}, ${ids[1]}. Source ${ids[2]} and its records stay, so the next prune repeats it. Busy.`,
  );
});

test("a prune defect keeps its own cause", async () => {
  const sourceId = await registered(["read"]);
  await reset(sourceId);
  spyOn(Date, "now").mockReturnValue(Date.now() + 15 * day);
  const cause = new TypeError("state defect");
  spyOn(DeviceState, "pruneSource").mockImplementation(() =>
    fromThrowable(
      () => {
        // oxlint-disable-next-line unthrown/no-throw -- Inject a defect at the device-state interface.
        throw cause;
      },
      (thrown, defect) => defect(thrown),
    )(),
  );
  const result = await WorkSources.prune({ paths, cwd: checkout });
  expect(result.tag === "Defect" ? result.cause : null).toBe(cause);
});

test("a planned key with no stored row is kept by reset", async () => {
  const sourceId = await registered(["read"]);
  const original = DeviceState.resetSource;
  spyOn(DeviceState, "resetSource").mockImplementation((p, target, decide) =>
    original(p, target, (facts) => decide({ ...facts, assignments: [] })),
  );
  expect(await reset(sourceId)).toMatchObject({
    tag: "Ok",
    value: { preserved: ["read"], abandoned: [] },
  });
});

test("abandon changes only its selected assignment and refuses missing or ended work without writes", async () => {
  const sourceId = await registered(["read", "other"]);
  const input = { paths, cwd: checkout, sourceId };
  const database = Bun.file(paths.database);
  const before = await database.bytes();
  const missing = await WorkSources.abandon({ ...input, assignment: "missing" });
  expect(missing).toMatchObject({
    tag: "Err",
    error: {
      reason: "assignment_not_found",
      state: { assignment: "missing" },
      next: { command: `operator source show --source ${sourceId}` },
    },
  });
  if (missing.tag === "Err") {
    expect(missing.error.detail.length).toBeGreaterThan(0);
    expect(
      z.object({ next: z.object({ why: z.string().min(1) }) }).safeParse(missing.error).success,
    ).toBe(true);
  }
  expect(await database.bytes()).toEqual(before);
  const abandoned = await WorkSources.abandon({ ...input, assignment: "read" });
  expect(abandoned).toMatchObject({
    tag: "Ok",
    value: { assignment: "read", ended: ["read"], retained: [] },
  });
  if (abandoned.tag === "Ok") {
    expect(abandoned.value.next.command).toBe(`operator next --source ${sourceId}`);
    expect(abandoned.value.next.why.length).toBeGreaterThan(0);
  }
  expect((await WorkSources.show(input)).getOr(undefined)?.assignments).toMatchObject([
    { key: "read", state: "abandoned" },
    { key: "other", state: "ready" },
  ]);
  const ended = await database.bytes();
  expect(await WorkSources.abandon({ ...input, assignment: "read" })).toMatchObject({
    tag: "Err",
    error: {
      reason: "assignment_ended",
      state: { found: "abandoned" },
      next: { why: "Nothing is left to abandon." },
    },
  });
  expect(await database.bytes()).toEqual(ended);
});

test("abandon refuses corrupt persisted assignment state without repairing it", async () => {
  const sourceId = await registered(["read"]);
  {
    using db = new Database(paths.database);
    db.exec("UPDATE assignments SET state = 'corrupt'");
  }
  const before = await Bun.file(paths.database).bytes();
  const refusal = await WorkSources.abandon({ paths, cwd: checkout, sourceId, assignment: "read" });
  expect(refusal).toMatchObject({
    tag: "Err",
    error: { reason: "state_corrupt", state: { found: "corrupt" }, next: { decider: "person" } },
  });
  if (refusal.tag === "Err") {
    expect(refusal.error.detail.length).toBeGreaterThan(0);
    expect(
      z.object({ next: z.object({ question: z.string().min(1) }) }).safeParse(refusal.error)
        .success,
    ).toBe(true);
  }
  expect(await Bun.file(paths.database).bytes()).toEqual(before);
});

test.each(["completed", "merged"])(
  "abandon refuses %s work and next never probes its closed worker",
  async (state) => {
    const completion = state === "merged" ? "pr" : "report";
    const registered = await register({
      trackerKey: "APP-closed",
      assignments: [
        { ...assignment("closed", completion), resources: "worktree", branch: "task/closed" },
        assignment("other"),
      ],
    });
    expect(registered.tag).toBe("Ok");
    if (registered.tag !== "Ok") return;
    const sourceId = registered.value.id;
    const id = launch(sourceId, "closed", "running");
    if (state === "merged") {
      expect(
        DeviceState.associatePullRequest(paths, id, {
          number: 7,
          url: "https://github.com/example/one/pull/7",
          branch: "task/closed",
          relay: null,
        }).tag,
      ).toBe("Ok");
      expect(
        DeviceState.recordPullRequestMerge(
          paths,
          id,
          { number: 7, head: "head", mergeCommit: "merge" },
          WorkSources.stateAfter,
        ).tag,
      ).toBe("Ok");
    } else setState(sourceId, "closed", "completed");
    const before = await Bun.file(paths.database).bytes();
    const refusal = await WorkSources.abandon({
      paths,
      cwd: checkout,
      sourceId,
      assignment: "closed",
    });
    expect(refusal).toMatchObject({
      tag: "Err",
      error: { reason: "assignment_ended", state: { found: state } },
    });
    if (refusal.tag === "Err") expect(refusal.error.detail.length).toBeGreaterThan(0);
    expect(await Bun.file(paths.database).bytes()).toEqual(before);
    spyOn(Environment, "read").mockReturnValue({
      ...Environment.read(),
      HERDR_SOCKET_PATH: "/herdr.sock",
    });
    const names = spyOn(Herdr, "agentNames").mockReturnValue(OkAsync([]));
    const pane = spyOn(Herdr, "pane").mockReturnValue(OkAsync(null));
    expect((await WorkSources.next({ paths, cwd: checkout, sourceId })).tag).toBe("Ok");
    expect(names).not.toHaveBeenCalled();
    expect(pane).not.toHaveBeenCalled();
  },
);

test.each(["completed", "merged", "abandoned"])(
  "next preserves a concurrent %s assignment end before applying older resource observations",
  async (state) => {
    const completion = state === "merged" ? "pr" : "report";
    const registered = await register({
      trackerKey: "APP-concurrent-end",
      assignments: [
        { ...assignment("closed", completion), resources: "worktree", branch: "task/closed" },
        assignment("other"),
      ],
    });
    expect(registered.tag).toBe("Ok");
    if (registered.tag !== "Ok") return;
    const sourceId = registered.value.id;
    const id = launch(sourceId, "closed", "running");
    spyOn(Environment, "read").mockReturnValue({
      ...Environment.read(),
      HERDR_SOCKET_PATH: "/herdr.sock",
    });
    spyOn(Herdr, "agentNames").mockReturnValue(OkAsync([]));
    spyOn(Herdr, "pane").mockReturnValue(OkAsync(null));
    const end = DeviceState.endAssignments;
    spyOn(DeviceState, "endAssignments").mockImplementation((p, target, decide) => {
      if (state === "merged") {
        expect(
          DeviceState.associatePullRequest(paths, id, {
            number: 7,
            url: "https://github.com/example/one/pull/7",
            branch: "task/closed",
            relay: null,
          }).tag,
        ).toBe("Ok");
        expect(
          DeviceState.recordPullRequestMerge(
            paths,
            id,
            { number: 7, head: "head", mergeCommit: "merge" },
            WorkSources.stateAfter,
          ).tag,
        ).toBe("Ok");
      } else setState(sourceId, "closed", state);
      return end(p, target, decide);
    });
    expect((await WorkSources.next({ paths, cwd: checkout, sourceId })).tag).toBe("Ok");
    expect((await shown(sourceId))?.assignments.find((row) => row.key === "closed")).toMatchObject({
      state,
    });
  },
);

test.each([
  { field: "id", column: "id", value: "replacement-launch" },
  { field: "assignment", column: "assignment", value: "other" },
  { field: "worktreePath", column: "worktree_path", value: "/isolated/replacement" },
  { field: "state", column: "state", value: "failed" },
  { field: "name", column: "name", value: "replacement-worker" },
  { field: "paneId", column: "pane_id", value: "w1:replacement" },
  { field: "herdrSocket", column: "herdr_socket", value: "/other.sock" },
  { field: "resources", column: "resources", value: "pane" },
])(
  "next revalidates observed $field under the writer reservation before ending or interrupting a launch",
  async ({ field, column, value }) => {
    const sourceId = await registered(["read", "other"]);
    const id = launch(sourceId, "read", "running");
    spyOn(Environment, "read").mockReturnValue({
      ...Environment.read(),
      HERDR_SOCKET_PATH: "/herdr.sock",
    });
    spyOn(Herdr, "agentNames").mockReturnValue(OkAsync([]));
    spyOn(Herdr, "pane").mockReturnValue(OkAsync(null));
    const end = DeviceState.endAssignments;
    spyOn(DeviceState, "endAssignments").mockImplementation((p, target, decide) => {
      // A concurrent resource update wins before the writer reserves the source.
      {
        using db = new Database(paths.database);
        if (field === "assignment")
          db.exec("UPDATE assignments SET state = 'running' WHERE key = 'other'");
        db.query(`UPDATE launches SET ${column} = ? WHERE id = ?`).run(value, id);
      }
      return end(p, target, decide);
    });
    expect(await WorkSources.next({ paths, cwd: checkout, sourceId })).toMatchObject({ tag: "Ok" });
    const source = await shown(sourceId);
    expect(source?.assignments.find((row) => row.key === "read")).toMatchObject({
      state: "running",
    });
    expect(
      DeviceState.readSources(paths, "example/one", sourceId).getOr([])[0]?.launches[0],
    ).toMatchObject({ [field]: value });
    if (field !== "state") expect(source?.launches[0]?.state).toBe("running");
  },
);

test("next persists missing pane and worktree ends, keeps existing work, and renders complete ended rows", async () => {
  const registered = await register({
    trackerKey: "APP-resources",
    assignments: [
      { ...assignment("read"), resources: "worktree", branch: "task/read" },
      assignment("pane"),
      assignment("other"),
    ],
  });
  expect(registered.tag).toBe("Ok");
  if (registered.tag !== "Ok") return;
  const sourceId = registered.value.id;
  const read = launch(sourceId, "read", "running");
  const pane = launch(sourceId, "pane", "running");
  {
    using db = new Database(paths.database);
    db.query("UPDATE launches SET resources = 'pane', worktree_path = NULL WHERE id = ?").run(pane);
  }
  await mkdir(`${root}/worktrees/read`, { recursive: true });
  await Bun.write(`${root}/worktrees/read/notes.md`, "keep\n");
  expect(
    DeviceState.registerProject(paths, {
      repository: "aaa/other",
      checkout: "/isolated/other",
      registeredAt: "now",
    }).tag,
  ).toBe("Ok");
  spyOn(Environment, "read").mockReturnValue({
    ...Environment.read(),
    HERDR_SOCKET_PATH: "/herdr.sock",
  });
  const names = spyOn(Herdr, "agentNames").mockReturnValue(OkAsync([]));
  const query = spyOn(Herdr, "pane").mockReturnValue(OkAsync({ tabId: "t1", workspaceId: "w1" }));
  const input = { paths, cwd: checkout, sourceId };
  expect((await WorkSources.next(input)).getOr(undefined)?.sources[0]?.waits).toMatchObject([
    { assignment: "read", action: "wait" },
    { assignment: "pane", action: "wait" },
  ]);
  query.mockReturnValue(OkAsync(null));
  const missing = await WorkSources.next(input);
  expect(missing.getOr(undefined)?.sources[0]?.actions).toMatchObject([
    { assignment: "read", action: "replace_worker" },
    { assignment: "pane", action: "ended", blockers: [] },
    { assignment: "other", action: "ready_assignment" },
  ]);
  expect(await shown(sourceId)).toMatchObject({
    assignments: [
      { key: "read", state: "running" },
      { key: "pane", state: "abandoned" },
      { key: "other", state: "ready" },
    ],
  });
  const persisted = await shown(sourceId);
  expect(persisted?.launches.find((row) => row.id === read)).toMatchObject({
    state: "interrupted",
  });
  expect(persisted?.launches.find((row) => row.id === pane)).toMatchObject({
    state: "interrupted",
  });
  expect(await Bun.file(`${root}/worktrees/read/notes.md`).text()).toBe("keep\n");
  await rm(`${root}/worktrees/read`, { recursive: true });
  const ended = await WorkSources.next(input);
  expect(ended.getOr(undefined)?.sources[0]?.actions).toMatchObject([
    { assignment: "read", action: "ended", blockers: [] },
    { assignment: "pane", action: "ended", blockers: [] },
    { assignment: "other", action: "ready_assignment" },
  ]);
  expect((await shown(sourceId))?.assignments).toMatchObject([
    { key: "read", state: "abandoned" },
    { key: "pane", state: "abandoned" },
    { key: "other", state: "ready" },
  ]);
  query.mockClear();
  names.mockClear();
  expect((await WorkSources.next(input)).tag).toBe("Ok");
  expect(query).not.toHaveBeenCalled();
  expect(names).not.toHaveBeenCalled();
});

test.each(["interrupted", "finished", "failed"])(
  "next ends a missing worktree after recorded %s even while the pane remains",
  async (state) => {
    const registered = await register({
      trackerKey: "APP-terminal",
      assignments: [
        { ...assignment("read"), resources: "worktree", branch: "task/read" },
        assignment("other"),
      ],
    });
    expect(registered.tag).toBe("Ok");
    if (registered.tag !== "Ok") return;
    const sourceId = registered.value.id;
    const id = launch(sourceId, "read", "running");
    {
      using db = new Database(paths.database);
      db.query("UPDATE launches SET state = ? WHERE id = ?").run(state, id);
    }
    spyOn(Environment, "read").mockReturnValue({
      ...Environment.read(),
      HERDR_SOCKET_PATH: "/herdr.sock",
    });
    spyOn(Herdr, "agentNames").mockReturnValue(OkAsync([]));
    spyOn(Herdr, "pane").mockReturnValue(OkAsync({ tabId: "t1", workspaceId: "w1" }));
    expect(
      (await WorkSources.next({ paths, cwd: checkout, sourceId })).getOr(undefined)?.sources[0]
        ?.actions,
    ).toMatchObject([
      { assignment: "read", action: "ended" },
      { assignment: "other", action: "ready_assignment" },
    ]);
    expect((await shown(sourceId))?.assignments[0]).toMatchObject({
      key: "read",
      state: "abandoned",
    });
  },
);

test("a real session wait observes and returns only its supervised source", async () => {
  const selected = await registered(["selected"], "APP-selected");
  const other = await registered(["outside"], "APP-outside");
  launch(selected, "selected", "running");
  launch(other, "outside", "running");
  {
    using db = new Database(paths.database);
    db.query("UPDATE sources SET supervising_session = ? WHERE id = ?").run("ses_scope", selected);
    db.query("UPDATE sources SET supervising_session = ? WHERE id = ?").run("ses_other", other);
  }
  spyOn(Environment, "read").mockReturnValue({
    ...Environment.read(),
    HERDR_SOCKET_PATH: "/herdr.sock",
    HERDR_PANE_ID: "super:p0",
    OPENCODE_SESSION_ID: "ses_scope",
    CLAUDE_CODE_SESSION_ID: undefined,
  });
  spyOn(Herdr, "agentNames").mockReturnValue(OkAsync([]));
  spyOn(Herdr, "pane").mockReturnValue(OkAsync(null));
  const next = await WorkSources.wait({ paths, cwd: checkout, timeoutSeconds: 0, all: true });
  expect(next).toMatchObject({
    tag: "Ok",
    value: {
      data: { sources: [{ id: selected, actions: [{ assignment: "selected", action: "ended" }] }] },
    },
  });
  expect((await shown(other))?.assignments).toMatchObject([{ key: "outside", state: "running" }]);
});

test("next names every retained assignment path after a later pathless launch and leaves other assignments separate", async () => {
  const registered = await register({
    trackerKey: "APP-retained",
    assignments: [
      { ...assignment("read"), resources: "worktree", branch: "task/read" },
      assignment("other"),
    ],
  });
  expect(registered.tag).toBe("Ok");
  if (registered.tag !== "Ok") return;
  const sourceId = registered.value.id;
  const first = launch(sourceId, "read", "failed");
  await mkdir(`${root}/worktrees/read`, { recursive: true });
  await Bun.write(`${root}/worktrees/read/notes.md`, "keep\n");
  const later = launch(sourceId, "read", "failed");
  {
    using db = new Database(paths.database);
    db.query("UPDATE launches SET worktree_path = NULL WHERE id = ?").run(later);
  }
  expect(
    await WorkSources.abandon({ paths, cwd: checkout, sourceId, assignment: "read" }),
  ).toMatchObject({
    tag: "Ok",
    value: { ended: ["read"], retained: [{ worktreePath: `${root}/worktrees/read` }] },
  });
  expect(
    (await WorkSources.next({ paths, cwd: checkout, sourceId })).getOr(undefined)?.sources[0]
      ?.actions,
  ).toMatchObject([
    {
      assignment: "read",
      action: "person_decision",
      reason: "cleanup_unlanded_work",
      retainedResources: [{ worktreePath: `${root}/worktrees/read`, branch: "task/read" }],
    },
    { assignment: "other", action: "ready_assignment" },
  ]);
  expect((await shown(sourceId))?.launches.map((row) => row.id)).toEqual([first, later]);
  expect(await Bun.file(`${root}/worktrees/read/notes.md`).text()).toBe("keep\n");
  await rm(`${root}/worktrees/read`, { recursive: true });
  expect(
    (await WorkSources.next({ paths, cwd: checkout, sourceId })).getOr(undefined)?.sources[0]
      ?.actions,
  ).toMatchObject([
    { assignment: "read", action: "ended" },
    { assignment: "other", action: "ready_assignment" },
  ]);
});

test("next observes a recorded finished pane assignment before ending it", async () => {
  const sourceId = await registered(["pane", "other"]);
  const id = launch(sourceId, "pane", "running");
  {
    using db = new Database(paths.database);
    db.query(
      "UPDATE launches SET resources = 'pane', worktree_path = NULL, state = 'finished' WHERE id = ?",
    ).run(id);
  }
  spyOn(Environment, "read").mockReturnValue({
    ...Environment.read(),
    HERDR_SOCKET_PATH: "/herdr.sock",
  });
  spyOn(Herdr, "agentNames").mockReturnValue(OkAsync([]));
  const pane = spyOn(Herdr, "pane").mockReturnValue(OkAsync(null));
  const answer = await WorkSources.next({ paths, cwd: checkout, sourceId });
  expect(answer).toMatchObject({
    tag: "Ok",
    value: {
      sources: [
        {
          actions: [
            { assignment: "pane", action: "ended" },
            { assignment: "other", action: "ready_assignment" },
          ],
        },
      ],
    },
  });
  expect(pane).toHaveBeenCalledWith("w1:pane");
  expect((await shown(sourceId))?.launches.find((row) => row.id === id)).toMatchObject({
    state: "finished",
  });
});

test("repeated real waits preserve acknowledged actions instead of reporting them again", async () => {
  await registered(["one", "two"]);
  const input = { paths, cwd: checkout, timeoutSeconds: 0 };
  expect(await WorkSources.wait(input)).toMatchObject({
    tag: "Ok",
    value: { reason: "next_actions_changed" },
  });
  for (const attempt of [1, 2]) {
    expect(await WorkSources.wait(input), `unchanged wait ${attempt}`).toMatchObject({
      tag: "Ok",
      value: { reason: "next_wait_timed_out", data: { sources: [] } },
    });
  }
});

test("retained resources appear only after abandonment, and a reset source keeps no new resource decision", async () => {
  const result = await register({
    trackerKey: "APP-retained-close",
    assignments: [
      { ...assignment("read"), resources: "worktree", branch: "task/read" },
      assignment("other"),
    ],
  });
  expect(result.tag).toBe("Ok");
  if (result.tag !== "Ok") return;
  const sourceId = result.value.id;
  launch(sourceId, "read", "failed");
  await mkdir(`${root}/worktrees/read`, { recursive: true });
  const active = await WorkSources.next({ paths, cwd: checkout, sourceId });
  expect(active.tag).toBe("Ok");
  if (active.tag === "Ok")
    expect(active.value.sources[0]?.actions[0]).not.toHaveProperty("retainedResources");
  expect(
    (await WorkSources.abandon({ paths, cwd: checkout, sourceId, assignment: "read" })).tag,
  ).toBe("Ok");
  expect((await reset(sourceId)).tag).toBe("Ok");
  const closed = await WorkSources.next({ paths, cwd: checkout, sourceId, all: true });
  expect(closed).toMatchObject({
    tag: "Ok",
    value: { sources: [{ actions: [{ action: "source_ended" }] }] },
  });
  if (closed.tag === "Ok") expect(closed.value.sources[0]?.actions).toHaveLength(1);
});

test("one abandoned assignment does not expose an unrelated completed assignment as newly ended", async () => {
  const sourceId = await registered(["abandoned", "completed"]);
  expect(
    (await WorkSources.abandon({ paths, cwd: checkout, sourceId, assignment: "abandoned" })).tag,
  ).toBe("Ok");
  setState(sourceId, "completed", "completed");
  const next = await WorkSources.next({ paths, cwd: checkout, sourceId });
  expect(next).toMatchObject({
    tag: "Ok",
    value: { sources: [{ actions: [{ assignment: "abandoned", action: "ended" }] }] },
  });
  if (next.tag === "Ok") expect(next.value.sources[0]?.actions).toHaveLength(1);
});

test("a finished source retains its pending merge cleanup without adding retained assignment resources", async () => {
  const result = await register({
    trackerKey: "APP-merged-cleanup",
    assignments: [assignment("merged", "pr")],
  });
  expect(result.tag).toBe("Ok");
  if (result.tag !== "Ok") return;
  const sourceId = result.value.id;
  const id = launch(sourceId, "merged", "running");
  await mkdir(`${root}/worktrees/merged`, { recursive: true });
  expect(
    DeviceState.associatePullRequest(paths, id, {
      number: 7,
      url: "https://github.com/example/one/pull/7",
      branch: "task/merged",
      relay: null,
    }).tag,
  ).toBe("Ok");
  expect(
    DeviceState.recordPullRequestMerge(
      paths,
      id,
      { number: 7, head: "head", mergeCommit: "merge" },
      WorkSources.stateAfter,
    ).tag,
  ).toBe("Ok");
  const next = await WorkSources.next({ paths, cwd: checkout, sourceId, all: true });
  expect(next).toMatchObject({
    tag: "Ok",
    value: {
      sources: [
        {
          actions: [{ action: "source_ended" }, { assignment: "merged", action: "retry_cleanup" }],
        },
      ],
    },
  });
  if (next.tag === "Ok")
    expect(next.value.sources[0]?.actions[1]).not.toHaveProperty("retainedResources");
});
