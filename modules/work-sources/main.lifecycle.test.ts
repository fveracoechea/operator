import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
// Bun has no temporary-directory, folder creation, or recursive removal API.
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Err, fromThrowable, Ok } from "unthrown";
import { DeviceState } from "../device-state/main.ts";
import { Environment } from "../environment/main.ts";
import { OperatorHome } from "../operator-home/main.ts";
import { Projects } from "../projects/main.ts";
import { WorkSources } from "./main.ts";

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
