import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
// Bun has no recursive removal, permission, or directory inspection API.
import { chmod, rm, stat } from "node:fs/promises";
import { z } from "zod";
import { workerDevice } from "./worker-fixture.ts";

let device: Awaited<ReturnType<typeof workerDevice>>;
afterEach(async () => {
  await rm(device.root, { recursive: true, force: true });
});

const retentionMs = 14 * 24 * 60 * 60 * 1000;
const report = {
  conclusion: "The module has two gaps.",
  evidence: ["modules/a.ts:10 reads no state."],
  unresolved: [],
};
const eligible = {
  reviewDecision: "APPROVED",
  reviews: [{ id: "R1", state: "APPROVED", body: "" }],
  checks: [{ name: "lint", conclusion: "SUCCESS" }],
};

function reportAssignment(key: string, dependencies: string[] = []) {
  return {
    key,
    trackerKey: `github:example/one#${key}`,
    instructions: `Read the module and report about ${key}.`,
    completion: "report",
    resources: "pane",
    dependencies,
  };
}

function prAssignment(key: string) {
  return {
    key,
    trackerKey: `github:example/one#${key}`,
    instructions: `Implement ${key}.`,
    completion: "pr",
    resources: "worktree",
    branch: `task/${key}`,
    dependencies: [],
  };
}

function database() {
  return `${device.root}/state/operator/operator.sqlite`;
}

function sourceDirectory(source: string, repository = "example/one") {
  return `${device.root}/state/operator/projects/${repository}/sources/${source}`;
}

/** Recorded time is a fact that the clock owns, so a test moves the end instead of the clock. */
function endedBefore(source: string, ms: number) {
  using db = new Database(database());
  db.query("UPDATE sources SET ended_at = ? WHERE id = ?").run(
    new Date(Date.now() - ms).toISOString(),
    source,
  );
}

async function git(cwd: string, ...args: string[]) {
  const result = await device.exec(["git", ...args], cwd);
  expect(result.code, result.stderr).toBe(0);
  return result.stdout.trim();
}

/** Branches, worktrees, Herdr calls, and GitHub calls that a reset or prune must not change. */
async function externalEffects() {
  const calls = Bun.file(`${device.root}/gh-calls.jsonl`);
  return {
    branches: await git(device.main, "branch", "--list", "--format=%(refname) %(objectname)"),
    worktrees: await git(device.main, "worktree", "list", "--porcelain"),
    herdr: await device.herdrCalls(),
    github: (await calls.exists()) ? await calls.text() : "",
  };
}

async function shown(source: string, cwd = device.main) {
  const result = await device.run(["source", "show", "--source", source], { cwd });
  return z
    .object({
      data: z.looseObject({
        state: z.string(),
        endedAt: z.string().nullable(),
        assignments: z.array(z.object({ key: z.string(), state: z.string() })),
        launches: z.array(z.looseObject({})),
        cleanups: z.array(z.looseObject({ state: z.string(), running: z.boolean() })),
      }),
    })
    .parse(result.output).data;
}

async function sourceNext(source: string, cwd = device.main) {
  const read = await device.run(["next", "--source", source], { cwd });
  return z
    .object({
      data: z.object({
        sources: z.array(
          z.object({
            id: z.string(),
            state: z.string(),
            actions: z.array(z.looseObject({ action: z.string() })),
            waits: z.array(z.looseObject({})),
          }),
        ),
      }),
    })
    .parse(read.output).data.sources[0];
}

async function submitAndAccept(source: string, key: string) {
  const worker = await device.dispatch(source, key);
  const file = await device.writeJson(`${key}.json`, report);
  expect(
    (await device.run(["report", "submit", "--file", file], { pane: worker.paneId })).code,
  ).toBe(0);
  const accepted = await device.run(["report", "accept", "--source", source, "--assignment", key]);
  expect(accepted.code, accepted.stderr).toBe(0);
  return z
    .object({ data: z.object({ conclusion: z.string(), reference: z.string(), file: z.string() }) })
    .parse(accepted.output).data;
}

/** Herdr reports that the worker's process ended, so its launch is interrupted. */
async function stopWorker(paneId: string) {
  const [workspace] = paneId.split(":");
  expect(
    (await device.exec(["herdr", "pane", "exit", paneId, workspace ?? ""], device.main)).code,
  ).toBe(0);
}

async function github(pull: object, branch: string, head: string) {
  const file = Bun.file(`${device.root}/github.json`);
  const state = z
    .object({
      pulls: z.array(z.looseObject({})).default([]),
      branches: z.record(z.string(), z.string()).default({}),
    })
    .loose()
    .parse((await file.exists()) ? await file.json() : {});
  await Bun.write(
    file,
    JSON.stringify({
      ...state,
      pulls: [...state.pulls, pull],
      branches: { ...state.branches, [branch]: head },
    }),
  );
}

/** The owner commits in its worktree, opens a PR at that head, and associates it. */
async function openPullRequest(source: string, key: string, number: number) {
  const worker = await device.dispatch(source, key);
  const worktree = worker.worktreePath ?? "";
  await Bun.write(`${worktree}/${key}.txt`, `${key}\n`);
  await git(worktree, "add", `${key}.txt`);
  await git(worktree, "commit", "-q", "-m", key);
  const head = await git(worktree, "rev-parse", "HEAD");
  await github(
    {
      number,
      url: `https://github.com/example/one/pull/${number}`,
      headRefName: `task/${key}`,
      headRepository: "example/one",
      state: "OPEN",
      head,
      ...eligible,
    },
    `task/${key}`,
    head,
  );
  const associated = await device.run(["pr", "associate"], { cwd: worktree });
  expect(associated.code, associated.stderr).toBe(0);
  return { ...worker, worktree, head };
}

async function mergedPullRequest(source: string, key: string, number: number) {
  const worker = await openPullRequest(source, key, number);
  const merged = await device.run(["pr", "merge"], { cwd: worker.worktree });
  expect(merged.code, merged.stderr).toBe(0);
  // The merge starts cleanup in its own process. Wait until that process stops.
  const deadline = Date.now() + 30000;
  for (;;) {
    const cleanup = (await shown(source)).cleanups[0];
    if (cleanup !== undefined && !cleanup.running && cleanup.state === "done") return worker;
    expect(Date.now()).toBeLessThan(deadline);
    await Bun.sleep(100);
  }
}

test("reset preserves merged and completed work, abandons the rest, and refuses while a worker runs", async () => {
  device = await workerDevice({ github: true });
  const source = await device.register({
    trackerKey: "github:example/one#40",
    assignments: [
      prAssignment("merged"),
      reportAssignment("accepted"),
      prAssignment("open"),
      reportAssignment("submitted"),
      reportAssignment("running"),
      reportAssignment("idle", ["accepted"]),
    ],
  });
  const merged = await mergedPullRequest(source, "merged", 7);
  await submitAndAccept(source, "accepted");
  const open = await openPullRequest(source, "open", 8);
  await stopWorker(open.paneId);
  const submitted = await device.dispatch(source, "submitted");
  const file = await device.writeJson("submitted.json", report);
  expect(
    (await device.run(["report", "submit", "--file", file], { pane: submitted.paneId })).code,
  ).toBe(0);
  await stopWorker(submitted.paneId);
  const running = await device.dispatch(source, "running");

  const before = await Bun.file(database()).arrayBuffer();
  const effects = await externalEffects();
  expect(await device.run(["source", "reset", "--source", source])).toMatchObject({
    code: 3,
    output: { reason: "person_instruction_required" },
  });
  const refused = await device.run(["source", "reset", "--source", source, "--person-instructed"]);
  expect(refused).toMatchObject({ code: 3, output: { reason: "source_worker_running" } });
  // The refusal names the pane to close, because no Operator command stops a worker.
  expect(refused.stderr).toContain(`running (pane ${running.paneId})`);
  expect(await Bun.file(database()).arrayBuffer()).toEqual(before);

  await stopWorker(running.paneId);
  const stopped = await externalEffects();
  const reset = await device.run(["source", "reset", "--source", source, "--person-instructed"]);
  expect(reset.code, reset.stderr).toBe(0);
  const data = z
    .object({ data: z.object({ endedAt: z.string(), prunableAt: z.string() }) })
    .parse(reset.output).data;
  expect(reset.output).toMatchObject({
    reason: "source_reset",
    data: {
      id: source,
      trackerKey: "github:example/one#40",
      state: "reset",
      preserved: ["merged", "accepted"],
      abandoned: ["open", "submitted", "running", "idle"],
      // The abandoned PR keeps its worktree, branch, and open PR. The merged worktree is gone.
      retained: [
        {
          assignment: "open",
          worktreePath: open.worktree,
          branch: "task/open",
          pullRequest: "https://github.com/example/one/pull/8",
        },
      ],
    },
  });
  expect(Date.parse(data.prunableAt) - Date.parse(data.endedAt)).toBe(retentionMs);

  // Reset changes records only. Branches, worktrees, panes, and GitHub stay as they were.
  expect(await externalEffects()).toEqual(stopped);
  expect(stopped.github).toBe(effects.github);
  expect(await Bun.file(`${open.worktree}/open.txt`).text()).toBe("open\n");
  expect(await Bun.file(submitted.brief).exists()).toBe(true);
  expect(await shown(source)).toMatchObject({
    state: "reset",
    endedAt: data.endedAt,
    assignments: [
      { key: "merged", state: "merged" },
      { key: "accepted", state: "completed" },
      { key: "open", state: "abandoned" },
      { key: "submitted", state: "abandoned" },
      { key: "running", state: "abandoned" },
      { key: "idle", state: "abandoned" },
    ],
  });
  expect(await sourceNext(source)).toEqual({
    id: source,
    state: "reset",
    actions: [
      {
        action: "source_ended",
        reason: "reset",
        endedAt: data.endedAt,
        prunableAt: data.prunableAt,
      },
    ],
    waits: [],
  });

  // Abandoned work starts nothing, and its old owner and report cannot continue it.
  const ended = await Bun.file(database()).arrayBuffer();
  expect(await device.run(["dispatch", "--source", source, "--assignment", "idle"])).toMatchObject({
    code: 4,
    output: { reason: "assignment_not_dispatchable" },
  });
  expect(await device.run(["pr", "associate"], { cwd: open.worktree })).toMatchObject({
    output: { outcome: "refused" },
  });
  expect(
    await device.run(["report", "accept", "--source", source, "--assignment", "submitted"]),
  ).toMatchObject({ code: 3, output: { reason: "report_not_submitted" } });
  expect(
    await device.run(["source", "reset", "--source", source, "--person-instructed"]),
  ).toMatchObject({
    code: 3,
    output: { reason: "source_ended" },
  });
  expect(await Bun.file(database()).arrayBuffer()).toEqual(ended);

  // Prune lists only work that still exists, not the worktree that merge cleanup removed.
  expect(await stat(merged.worktree).catch(() => null)).toBeNull();
  endedBefore(source, retentionMs + 60000);
  expect(await device.run(["source", "prune"])).toMatchObject({
    code: 0,
    output: {
      data: {
        pruned: [
          {
            id: source,
            retained: [
              {
                assignment: "open",
                worktreePath: open.worktree,
                branch: "task/open",
                pullRequest: "https://github.com/example/one/pull/8",
              },
            ],
          },
        ],
      },
    },
  });
}, 120000);

test("every other reset refusal leaves state unchanged", async () => {
  device = await workerDevice();
  const finished = await device.register({ trackerKey: "github:example/one#41", assignments: [] });
  const consumer = await device.checkout("two", "example/two");
  expect((await device.run(["project", "register"], { cwd: consumer })).code).toBe(0);
  const other = await device.register(
    { trackerKey: "github:example/two#1", assignments: [reportAssignment("read")] },
    consumer,
  );
  const before = await Bun.file(database()).arrayBuffer();
  for (const [args, cwd, reason] of [
    [["--source", finished], device.main, "source_ended"],
    [["--source", "missing"], device.main, "source_not_found"],
    // A source of another project cannot be reset from this checkout.
    [["--source", other], device.main, "source_not_found"],
  ] as const)
    expect(
      await device.run(["source", "reset", ...args, "--person-instructed"], { cwd }),
    ).toMatchObject({ code: 3, output: { reason } });
  expect(await Bun.file(database()).arrayBuffer()).toEqual(before);
  expect((await shown(other, consumer)).state).toBe("open");
}, 60000);

test("a reset parent registers again as a new source without adopting old resources", async () => {
  device = await workerDevice({ github: true });
  const plan = { trackerKey: "github:example/one#50", assignments: [prAssignment("build")] };
  const first = await device.register(plan);
  const old = await openPullRequest(first, "build", 9);
  await stopWorker(old.paneId);

  const file = await device.writeJson("plan.json", plan);
  const before = await Bun.file(database()).arrayBuffer();
  expect(await device.run(["source", "register", "--file", file])).toMatchObject({
    code: 4,
    output: { reason: "source_parent_open" },
  });
  expect(await Bun.file(database()).arrayBuffer()).toEqual(before);

  expect(
    (await device.run(["source", "reset", "--source", first, "--person-instructed"])).code,
  ).toBe(0);
  const second = await device.register(plan);
  expect(second).not.toBe(first);
  // Only one source of the parent is open at a time.
  expect(await device.run(["source", "register", "--file", file])).toMatchObject({
    code: 4,
    output: { reason: "source_parent_open" },
  });
  expect(await shown(second)).toMatchObject({
    state: "open",
    assignments: [{ key: "build", state: "ready" }],
    launches: [],
    pullRequests: [],
  });
  expect(await sourceNext(second)).toMatchObject({
    actions: [{ action: "ready_assignment", assignment: "build" }],
  });
  expect((await shown(first)).state).toBe("reset");
  // The old worktree stays, and its PR does not move to the new source.
  expect(await device.run(["pr", "associate"], { cwd: old.worktree })).toMatchObject({
    output: { outcome: "refused" },
  });
  expect(await git(device.main, "branch", "--list", "task/build")).toContain("task/build");
  expect((await shown(second)).pullRequests).toEqual([]);
}, 90000);

test("prune deletes an ended source only after 14 days and keeps worktrees, branches, and backups", async () => {
  device = await workerDevice();
  const source = await device.register({
    trackerKey: "github:example/one#60",
    assignments: [reportAssignment("investigate"), prAssignment("implement")],
  });
  const accepted = await submitAndAccept(source, "investigate");
  const worker = await device.dispatch(source, "implement");
  const worktree = worker.worktreePath ?? "";
  await Bun.write(`${worktree}/draft.ts`, "export {};\n");
  await stopWorker(worker.paneId);
  const openSource = await device.register({
    trackerKey: "github:example/one#61",
    assignments: [reportAssignment("other")],
  });
  expect(
    (await device.run(["source", "reset", "--source", source, "--person-instructed"])).code,
  ).toBe(0);
  const backup = `${device.root}/state/operator/backups/older/operator.sqlite`;
  await Bun.write(backup, "verified backup bytes", { createPath: true });

  // Just before the boundary the source stays with every file.
  endedBefore(source, retentionMs - 60000);
  expect((await sourceNext(source))?.actions.map((row) => row.action)).toEqual(["source_ended"]);
  const before = await Bun.file(database()).arrayBuffer();
  const early = await device.run(["source", "prune"]);
  expect(early).toMatchObject({
    code: 0,
    output: {
      reason: "sources_pruned",
      data: { pruned: [], kept: [{ id: source, state: "reset", reason: "retention_pending" }] },
    },
  });
  expect(await Bun.file(database()).arrayBuffer()).toEqual(before);
  expect(await Bun.file(accepted.file).exists()).toBe(true);

  // After the boundary next offers prune, and prune deletes records and device-state files.
  endedBefore(source, retentionMs + 60000);
  expect((await sourceNext(source))?.actions).toMatchObject([
    { action: "source_ended" },
    { action: "prune_source", reason: "retention_elapsed" },
  ]);
  const effects = await externalEffects();
  const pruned = await device.run(["source", "prune"]);
  expect(pruned).toMatchObject({
    code: 0,
    output: {
      data: {
        pruned: [
          {
            id: source,
            trackerKey: "github:example/one#60",
            state: "reset",
            retained: [
              {
                assignment: "implement",
                worktreePath: worktree,
                branch: "task/implement",
                pullRequest: null,
              },
            ],
          },
        ],
        kept: [],
      },
    },
  });
  expect(
    await Bun.file(`${sourceDirectory(source)}/assignments/investigate/brief.md`).exists(),
  ).toBe(false);
  expect(await Bun.file(accepted.file).exists()).toBe(false);
  expect(await device.run(["source", "show", "--source", source])).toMatchObject({
    code: 3,
    output: { reason: "source_not_found" },
  });
  // No archive remains, and nothing outside the source's state changed.
  for await (const name of new Bun.Glob("**/*").scan({
    cwd: `${device.root}/state/operator`,
    dot: true,
  }))
    expect(name).not.toContain(source);
  expect(await externalEffects()).toEqual(effects);
  expect(await Bun.file(`${worktree}/draft.ts`).text()).toBe("export {};\n");
  expect(await Bun.file(backup).text()).toBe("verified backup bytes");
  expect((await shown(openSource)).state).toBe("open");
  expect(await device.run(["source", "prune"])).toMatchObject({
    code: 0,
    output: { data: { pruned: [], kept: [] } },
  });
}, 90000);

test("failed file deletion keeps the source for a later prune in a new process", async () => {
  device = await workerDevice();
  const source = await device.register({
    trackerKey: "github:example/one#70",
    assignments: [reportAssignment("investigate")],
  });
  const accepted = await submitAndAccept(source, "investigate");
  endedBefore(source, retentionMs + 60000);
  const locked = `${sourceDirectory(source)}/assignments`;
  await chmod(locked, 0o500);
  try {
    const failed = await device.run(["source", "prune"]);
    expect(failed).toMatchObject({ code: 1, output: { reason: "source_prune_failed" } });
    expect(failed.stderr).toContain(`Source ${source} and its records stay`);
  } finally {
    await chmod(locked, 0o700);
  }
  expect((await shown(source)).state).toBe("finished");
  expect((await sourceNext(source))?.actions).toMatchObject([
    { action: "source_ended" },
    { action: "prune_source" },
  ]);
  // Deletion can stop part way, so only the records prove that the obligation stays.
  expect((await stat(locked)).isDirectory()).toBe(true);
  expect(await device.run(["source", "prune"])).toMatchObject({
    code: 0,
    output: { data: { pruned: [{ id: source, state: "finished" }] } },
  });
  expect(await Bun.file(accepted.file).exists()).toBe(false);
}, 60000);

test("an open cleanup keeps its ended source visible until the cleanup finishes", async () => {
  device = await workerDevice();
  const source = await device.register({
    trackerKey: "github:example/one#80",
    assignments: [reportAssignment("investigate")],
  });
  const worker = await device.dispatch(source, "investigate");
  const file = await device.writeJson("report.json", report);
  await device.run(["report", "submit", "--file", file], { pane: worker.paneId });
  await device.setHerdr({ fail: { "pane close": "herdr is restarting" } });
  const accept = ["report", "accept", "--source", source, "--assignment", "investigate"];
  expect(await device.run(accept)).toMatchObject({
    output: { data: { sourceFinished: true, cleanup: { state: "failed" } } },
  });
  endedBefore(source, retentionMs + 60000);
  const before = await Bun.file(database()).arrayBuffer();
  expect(await device.run(["source", "prune"])).toMatchObject({
    code: 0,
    output: { data: { pruned: [], kept: [{ id: source, reason: "cleanup_open" }] } },
  });
  expect(await Bun.file(database()).arrayBuffer()).toEqual(before);
  expect((await sourceNext(source))?.actions).toMatchObject([
    { action: "source_ended", reason: "finished" },
    { action: "retry_cleanup", reason: "cleanup_failed" },
  ]);
  await device.setHerdr({ fail: {} });
  expect(await device.run(accept)).toMatchObject({
    output: { data: { cleanup: { state: "done" } } },
  });
  expect(await device.run(["source", "prune"])).toMatchObject({
    output: { data: { pruned: [{ id: source }] } },
  });
}, 60000);

test("a consumer brief in another project keeps copied content after the producer is pruned", async () => {
  device = await workerDevice();
  const producer = await device.register({
    trackerKey: "github:example/one#90",
    assignments: [reportAssignment("investigate")],
  });
  const accepted = await submitAndAccept(producer, "investigate");
  const consumer = await device.checkout("two", "example/two");
  expect((await device.run(["project", "register"], { cwd: consumer })).code).toBe(0);
  const source = await device.register(
    {
      trackerKey: "github:example/two#1",
      assignments: [
        {
          ...reportAssignment("apply"),
          trackerKey: "github:example/two#2",
          instructions: `Apply this accepted finding from ${accepted.reference}: ${accepted.conclusion}`,
        },
      ],
    },
    consumer,
  );
  const launched = await device.dispatch(source, "apply", consumer);
  endedBefore(producer, retentionMs + 60000);

  // Prune acts only on the project of its checkout.
  expect(await device.run(["source", "prune"], { cwd: consumer })).toMatchObject({
    output: { data: { pruned: [], kept: [] } },
  });
  expect(await Bun.file(accepted.file).exists()).toBe(true);
  expect(await device.run(["source", "prune"])).toMatchObject({
    output: { data: { pruned: [{ id: producer }] } },
  });
  expect(await Bun.file(accepted.file).exists()).toBe(false);
  const brief = await Bun.file(launched.brief).text();
  expect(brief).toContain(accepted.reference);
  expect(brief).toContain(accepted.conclusion);
  expect((await shown(source, consumer)).state).toBe("open");
}, 60000);
