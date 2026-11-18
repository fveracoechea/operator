import { afterEach, beforeEach, expect, test } from "bun:test";
// Bun has no recursive removal API.
import { rm } from "node:fs/promises";
import { z } from "zod";
import { Database } from "bun:sqlite";
import { workerDevice } from "./worker-fixture.ts";

let device: Awaited<ReturnType<typeof workerDevice>>;
beforeEach(async () => {
  device = await workerDevice();
}, 60000);

test.each([
  ["missing", "Read the queue.", "invalid_source_plan", 2],
  ["research", "   ", "invalid_source_plan", 2],
])(
  "one-off dispatch refuses %s with no source or launch",
  async (kind, text, reason, code) => {
    const result = await device.run(["dispatch", "--kind", kind, "--brief", "-"], { stdin: text });
    expect(result).toMatchObject({
      code,
      output: {
        reason,
        next: {
          command: "operator dispatch --kind <kind> --brief <path|->",
          why: "Correct the kind, brief, or optional one-off flags before dispatching again.",
        },
        state: { inputValid: false },
      },
    });
    expect(result.output).not.toHaveProperty("kind");
    expect(result.output).not.toHaveProperty("phase");
    const planFile = await device.writeJson("invalid-plan.json", {});
    const plan = await device.run(["source", "register", "--file", planFile]);
    expect(plan).toMatchObject({
      code: 2,
      output: {
        reason: "invalid_source_plan",
        next: {
          decider: "super-agent",
          question: "What corrected source plan should be supplied in --file?",
        },
        state: { inputValid: false },
      },
    });
    expect((await device.run(["next"])).output).toMatchObject({ data: { sources: [] } });
    expect(await device.herdrCalls()).not.toContain("agent start");
  },
  60000,
);

test("one-off dispatch keeps a failed launch available for ordinary dispatch and reset", async () => {
  await device.setHerdr({ fail: { "plugin list": "unavailable" } });
  const result = await device.run(["dispatch", "--kind", "research", "--brief", "-"], {
    stdin: "Read the queue.",
  });
  expect(result).toMatchObject({
    code: 1,
    output: { reason: "herdr_failed", state: { exitCode: 1 } },
  });
  const next = await device.run(["next"]);
  const source = z
    .object({ data: z.object({ sources: z.array(z.object({ id: z.string() })) }) })
    .parse(next.output).data.sources[0];
  expect(source).toBeDefined();
  const sourceId = source?.id ?? "";
  expect(result.stderr).toContain(
    `operator dispatch --source ${sourceId} --assignment read-the-queue again`,
  );
  expect(await device.next("read-the-queue")).toMatchObject([{ reason: "assignment_ready" }]);
  expect(
    (await device.run(["source", "reset", "--source", sourceId, "--person-instructed"])).code,
  ).toBe(0);
  const endedAt = new Date(Date.now() - 15 * 24 * 60 * 60 * 1000).toISOString();
  // The clock owns this fact; only the isolated test device's recorded end is advanced.
  using db = new Database(`${device.root}/state/operator/operator.sqlite`);
  db.query("UPDATE sources SET ended_at = ? WHERE id = ?").run(endedAt, sourceId);
  const prune = await device.run(["source", "prune"]);
  expect(prune.code, prune.stderr).toBe(0);
  expect(prune.output).toMatchObject({ data: { pruned: [{ id: sourceId }], kept: [] } });
  expect((await device.run(["next", "--all"])).output).toMatchObject({ data: { sources: [] } });
}, 60000);

test.each([
  [["abandon", "--kind", "answer", "--brief", "-"]],
  [["dispatch", "--kind", "research"]],
  [["dispatch", "--brief", "-"]],
  [["dispatch", "--kind", "research", "--brief", "-", "--source", "s"]],
  [["dispatch", "--kind", "research", "--brief", "-", "--assignment", "a"]],
  [["dispatch", "--kind", "research", "--brief", "-", "--completion", "pr"]],
  [["dispatch", "--kind", "research", "--brief", "-", "--kind", "answer"]],
])(
  "one-off dispatch refuses mixed or unsupported flags %j",
  async (args) => {
    const result = await device.run(args, { stdin: "Read the queue." });
    expect(result).toMatchObject({ code: 2, output: { reason: "invalid_arguments" } });
    expect((await device.run(["next"])).output).toMatchObject({ data: { sources: [] } });
  },
  60000,
);

test("one-off dispatch reads stdin and preserves tracker, intent and profile", async () => {
  const result = await device.run(
    [
      "dispatch",
      "--kind",
      "answer",
      "--brief",
      "-",
      "--tracker-key",
      "github:example/one#42",
      "--intent",
      "Explain the queue without changing it.",
      "--profile",
      "careful",
    ],
    { stdin: "Describe queue ordering." },
  );
  expect(result.code, result.stderr).toBe(0);
  const data = z
    .object({ data: z.object({ sourceId: z.string(), brief: z.string() }) })
    .parse(result.output).data;
  const shown = await device.run(["source", "show", "--source", data.sourceId]);
  expect(shown.output).toMatchObject({
    data: {
      trackerKey: "github:example/one#42",
      plan: {
        assignments: [
          {
            kind: "answer",
            trackerKey: "github:example/one#42",
            instructions: "Describe queue ordering.",
            intent: "Explain the queue without changing it.",
            profile: "careful",
            resources: "pane",
          },
        ],
      },
      launches: [{ profile: "careful", reasoningEffort: "high", kind: { name: "answer" } }],
    },
  });
  expect(await Bun.file(data.brief).text()).toContain("> Explain the queue without changing it.");
}, 60000);

test.each(["prototype", "implementation"])(
  "one-off %s dispatch derives its completion and worktree",
  async (kind) => {
    const file = `${device.root}/task.md`;
    await Bun.write(file, "Build the queue view.");
    const result = await device.run(["dispatch", "--kind", kind, "--brief", file]);
    expect(result.code, result.stderr).toBe(0);
    const data = z
      .object({
        data: z.object({ sourceId: z.string(), worktreePath: z.string(), branch: z.string() }),
      })
      .parse(result.output).data;
    const shown = await device.run(["source", "show", "--source", data.sourceId]);
    expect(shown.output).toMatchObject({
      data: {
        plan: {
          assignments: [
            {
              kind,
              resources: "worktree",
              completion: kind === "prototype" ? "report" : "pr",
              branch: "build-the-queue-view",
            },
          ],
        },
        launches: [{ worktreePath: data.worktreePath, branch: data.branch, kind: { name: kind } }],
      },
    });
  },
  60000,
);
afterEach(async () => {
  await rm(device.root, { recursive: true, force: true });
}, 60000);

test("one-off dispatch creates a one-off source with one assignment and an optional tracker key", async () => {
  const file = `${device.root}/task.md`;
  await Bun.write(file, "Explain how the queue works.");
  const result = await device.run(["dispatch", "--kind", "research", "--brief", file]);
  expect(result.code, result.stderr).toBe(0);
  const data = z
    .object({ data: z.object({ sourceId: z.string(), assignment: z.string(), brief: z.string() }) })
    .parse(result.output).data;
  const shown = await device.run(["source", "show", "--source", data.sourceId]);
  expect(shown.output).toMatchObject({
    data: {
      trackerKey: expect.stringMatching(/^research:[0-9a-f]{8}$/) as unknown,
      plan: {
        assignments: [
          {
            key: data.assignment,
            kind: "research",
            completion: "report",
            resources: "pane",
            dependencies: [],
            instructions: "Explain how the queue works.",
          },
        ],
      },
      assignments: [{ key: data.assignment, completion: "report", state: "running" }],
    },
  });
  const plan = z
    .object({ data: z.object({ plan: z.object({ assignments: z.array(z.unknown()) }) }) })
    .parse(shown.output);
  expect(plan.data.plan.assignments).toHaveLength(1);
  expect(await Bun.file(data.brief).text()).toContain("Explain how the queue works.");
  expect(await device.next(data.assignment)).toMatchObject([{ reason: "assignment_active" }]);
}, 60000);

test("promotion adds a PR assignment without adding another planned assignment to a one-off source", async () => {
  const launched = await device.run(["dispatch", "--kind", "prototype", "--brief", "-"], {
    stdin: "Build a queue sketch.",
  });
  expect(launched.code, launched.stderr).toBe(0);
  const data = z
    .object({
      data: z.object({
        sourceId: z.string(),
        assignment: z.string(),
        paneId: z.string(),
        worktreePath: z.string(),
      }),
    })
    .parse(launched.output).data;
  const report = await device.writeReport("sketch-report.md", {
    conclusion: "The sketch is ready.",
    evidence: ["The queue sketch uses one state."],
    unresolved: [],
  });
  const submitted = await device.run(["report", "submit", "--file", report], {
    pane: data.paneId,
    cwd: data.worktreePath,
  });
  expect(submitted.code, submitted.stderr).toBe(0);
  const file = await device.writeJson("promotion.json", {
    key: "build",
    trackerKey: "github:example/one#43",
    instructions: "Implement the queue.",
    branch: "task/build",
  });
  const promoted = await device.run([
    "report",
    "accept",
    "--source",
    data.sourceId,
    "--assignment",
    data.assignment,
    "--promote",
    file,
  ]);
  expect(promoted.code, promoted.stderr).toBe(0);
  expect(promoted.output).toMatchObject({
    reason: "report_promoted",
    data: {
      state: "completed",
      promoted: { assignment: "build", worktreePath: data.worktreePath, state: "running" },
    },
  });
  const shown = await device.run(["source", "show", "--source", data.sourceId]);
  const source = z
    .object({
      data: z.object({
        plan: z.object({ assignments: z.array(z.object({ key: z.string() })) }),
        assignments: z.array(
          z.object({ key: z.string(), completion: z.string(), state: z.string() }),
        ),
      }),
    })
    .parse(shown.output).data;
  expect(source.plan.assignments).toEqual([{ key: data.assignment }]);
  expect(source.assignments).toEqual([
    { key: data.assignment, completion: "report", state: "completed" },
    { key: "build", completion: "pr", state: "running" },
  ]);
}, 60000);

test("one-off dispatch validates its file and start profile before registering a source", async () => {
  const missing = await device.run([
    "dispatch",
    "--kind",
    "research",
    "--brief",
    `${device.root}/missing.md`,
  ]);
  expect(missing).toMatchObject({
    code: 1,
    output: { reason: "source_io_failed", state: { code: "ENOENT" } },
  });
  const profile = await device.run(
    ["dispatch", "--kind", "research", "--brief", "-", "--profile", "missing"],
    { stdin: "Read the queue." },
  );
  expect(profile).toMatchObject({
    code: 3,
    output: { reason: "source_profile_missing", state: { profile: "missing", exists: false } },
  });
  expect((await device.run(["next"])).output).toMatchObject({ data: { sources: [] } });
  expect(await device.herdrCalls()).not.toContain("agent start");
}, 60000);

test("repeated one-off work creates separate sources but an explicit open tracker key stays exclusive", async () => {
  const args = ["dispatch", "--kind", "answer", "--brief", "-"];
  const first = await device.run(args, { stdin: "Read the queue." });
  const second = await device.run(args, { stdin: "Read the queue." });
  const launched = z.object({ data: z.object({ sourceId: z.string(), paneId: z.string() }) });
  expect([first.code, second.code]).toEqual([0, 0]);
  expect(launched.parse(first.output).data.sourceId).not.toBe(
    launched.parse(second.output).data.sourceId,
  );
  const tracked = [...args, "--tracker-key", "github:example/one#99"];
  expect((await device.run(tracked, { stdin: "Read the queue." })).code).toBe(0);
  const calls = await device.herdrCalls();
  const duplicate = await device.run(tracked, { stdin: "Read the queue." });
  expect(duplicate).toMatchObject({ code: 4, output: { reason: "source_parent_open" } });
  expect(await device.herdrCalls()).toEqual(calls);
  const sources = z
    .object({ data: z.object({ sources: z.array(z.unknown()) }) })
    .parse((await device.run(["next"])).output).data.sources;
  expect(sources).toHaveLength(3);
}, 60000);

test.each(["review", "pr-feedback"])(
  "one-off %s cannot bypass the plain-dispatch guard",
  async (kind) => {
    const result = await device.run(["dispatch", "--kind", kind, "--brief", "-"], {
      stdin: "Read the PR.",
    });
    expect(result).toMatchObject({
      code: 4,
      output: { reason: "kind_not_dispatchable", state: { kind } },
    });
    expect(await device.herdrCalls()).not.toContain("agent start");
  },
  60000,
);

test("ordinary dispatch retries a failed one-off launch without another source or planned assignment", async () => {
  await device.setHerdr({ fail: { "plugin list": "unavailable" } });
  const failed = await device.run(["dispatch", "--kind", "answer", "--brief", "-"], {
    stdin: "Read the queue.",
  });
  expect(failed.code).toBe(1);
  const sourceId =
    z
      .object({ data: z.object({ sources: z.array(z.object({ id: z.string() })).length(1) }) })
      .parse((await device.run(["next"])).output).data.sources[0]?.id ?? "";
  await device.setHerdr({ fail: {} });
  const retried = await device.run([
    "dispatch",
    "--source",
    sourceId,
    "--assignment",
    "read-the-queue",
  ]);
  expect(retried.code, retried.stderr).toBe(0);
  expect(retried.output).toMatchObject({
    data: { sourceId, assignment: "read-the-queue", kind: { name: "answer" } },
  });
  const shown = await device.run(["source", "show", "--source", sourceId]);
  const data = z
    .object({
      data: z.object({
        plan: z.object({ assignments: z.array(z.object({ key: z.string() })) }),
        launches: z.array(z.object({ state: z.string() })),
      }),
    })
    .parse(shown.output).data;
  expect(data.plan.assignments).toEqual([{ key: "read-the-queue" }]);
  expect(data.launches).toEqual([{ state: "running" }]);
}, 60000);
