import { afterEach, beforeEach, expect, test } from "bun:test";
// Bun has no recursive removal API.
import { rm } from "node:fs/promises";
import { z } from "zod";
import { workerDevice } from "./worker-fixture.ts";

let device: Awaited<ReturnType<typeof workerDevice>>;
beforeEach(async () => {
  device = await workerDevice();
}, 60000);
afterEach(async () => {
  await rm(device.root, { recursive: true, force: true });
}, 60000);

const asked = z.object({
  data: z.object({
    sourceId: z.string(),
    assignment: z.string(),
    brief: z.string(),
    paneId: z.string(),
    worktreePath: z.null(),
  }),
});

async function sources() {
  const read = await device.run(["next"]);
  return z.object({ data: z.object({ sources: z.array(z.looseObject({})) }) }).parse(read.output)
    .data.sources;
}

test("ask dispatches an answer kind", async () => {
  const question =
    "Why does `next --wait` return ended sources?\n## Not a brief section\nKeep $HOME and $(literal) unchanged.";
  const file = `${device.root}/question.txt`;
  await Bun.write(file, question);
  const result = await device.run(["ask", "--file", file]);
  expect(result.code, result.stderr).toBe(0);
  const data = asked.parse(result.output).data;
  expect(result.output).toMatchObject({
    operation: "ask",
    reason: "question_dispatched",
    data: { assignment: "why-does-next-wait-return-ended", attempt: 1, branch: null },
  });

  const shown = await device.run(["source", "show", "--source", data.sourceId]);
  expect(shown.output).toMatchObject({
    data: {
      trackerKey: expect.stringMatching(/^ask:[0-9a-f]{8}$/) as unknown,
      plan: {
        assignments: [
          {
            key: data.assignment,
            kind: "answer",
            completion: "report",
            resources: "pane",
            dependencies: [],
          },
        ],
      },
      launches: [
        {
          assignment: data.assignment,
          state: "running",
          paneId: data.paneId,
          kind: { name: "answer", resources: "pane" },
        },
      ],
    },
  });

  // The question stays quoted, so its text cannot open a brief section.
  const brief = await Bun.file(data.brief).text();
  expect(brief).toContain(
    "> Why does `next --wait` return ended sources?\n> ## Not a brief section\n> Keep $HOME and $(literal) unchanged.",
  );
  expect(brief).not.toContain("\n## Not a brief section");
  expect(brief).toContain("Completion: `report`");
  expect(brief).not.toContain("operator report submit");
  expect(await device.next(data.assignment)).toMatchObject([{ reason: "assignment_active" }]);

  // Acceptance works as for any report assignment.
  const report = await device.writeReport("report.md", {
    conclusion: "The unscoped wait returns every ended source.",
    evidence: ["modules/work-sources/coordination.ts:10 keeps ended sources."],
    unresolved: [],
  });
  const submitted = await device.run(["report", "submit", "--file", report], {
    pane: data.paneId,
  });
  expect(submitted.code, submitted.stderr).toBe(0);
  const accepted = await device.run([
    "report",
    "accept",
    "--source",
    data.sourceId,
    "--assignment",
    data.assignment,
  ]);
  expect(accepted.code, accepted.stderr).toBe(0);
  expect(await device.next(data.assignment)).toEqual([]);
}, 60000);

test("the same question asked twice gets two sources", async () => {
  const first = await device.run(["ask", "--file", "-"], { stdin: "Where is the brief written?" });
  const second = await device.run(["ask", "--file", "-"], { stdin: "Where is the brief written?" });
  expect([first.code, second.code]).toEqual([0, 0]);
  expect(asked.parse(first.output).data.sourceId).not.toBe(
    asked.parse(second.output).data.sourceId,
  );
  expect(asked.parse(first.output).data.paneId).not.toBe(asked.parse(second.output).data.paneId);
}, 60000);

test("ask starts the worker with a named start profile", async () => {
  const result = await device.run(["ask", "--file", "-", "--profile", "careful"], {
    stdin: "What changed?\nKeep `ticks`, $HOME and $(literal).",
  });
  expect(result.code, result.stderr).toBe(0);
  const data = asked.parse(result.output).data;
  const shown = await device.run(["source", "show", "--source", data.sourceId]);
  expect(shown.output).toMatchObject({
    data: { launches: [{ profile: "careful", reasoningEffort: "high" }] },
  });
  expect(await Bun.file(data.brief).text()).toContain(
    "> What changed?\n> Keep `ticks`, $HOME and $(literal).",
  );
}, 60000);

test("a question with no letters or digits gets a fixed assignment key", async () => {
  const result = await device.run(["ask", "--file", "-"], { stdin: "???" });
  expect(result.code, result.stderr).toBe(0);
  expect(result.output).toMatchObject({ data: { assignment: "question" } });
}, 60000);

test("a question that opens with a long token gets a key within the plan's limit", async () => {
  const result = await device.run(["ask", "--file", "-"], { stdin: `${"a".repeat(250)} is what?` });
  expect(result.code, result.stderr).toBe(0);
  expect(result.output).toMatchObject({ data: { assignment: "a".repeat(60) } });
}, 60000);

test("ask refuses an unknown profile and writes no source", async () => {
  const result = await device.run(["ask", "--file", "-", "--profile", "missing"], {
    stdin: "What changed?",
  });
  expect(result).toMatchObject({ code: 3, output: { reason: "source_profile_missing" } });
  expect(await sources()).toEqual([]);
  expect(await device.herdrCalls()).not.toContain("agent start");
}, 60000);

test("a failed ask keeps its registered source and the dispatch owner's recovery and checked facts", async () => {
  await device.setHerdr({ fail: { "plugin list": "plugin unavailable" } });
  const result = await device.run(["ask", "--file", "-"], { stdin: "Why does this stop?" });
  expect(result).toMatchObject({
    code: 1,
    output: {
      operation: "ask",
      reason: "herdr_failed",
      next: {
        decider: "super-agent",
        question:
          "How should the failed Herdr command and any existing effect be inspected before another request?",
      },
      state: { exitCode: 1 },
    },
  });
  const registered = await sources();
  expect(registered).toHaveLength(1);
  const source = z.object({ id: z.string() }).parse(registered[0]);
  expect(result.stderr).toContain(
    `Source ${source.id} holds the question. Run operator dispatch --source ${source.id} --assignment why-does-this-stop again.`,
  );
  expect(result.stderr.trim().split("\n")).toHaveLength(3);
  expect(await device.herdrCalls()).not.toContain("agent start");
  const shown = await device.run(["source", "show", "--source", source.id]);
  expect(shown.output).toMatchObject({
    data: { launches: [], assignments: [{ key: "why-does-this-stop", state: "ready" }] },
  });
}, 60000);

test.each([
  [["ask"]],
  [["ask", "--file"]],
  [["ask", "--file", "   "]],
  [["ask", "--file", "--profile"]],
  [["ask", "--file", "a", "--file", "b"]],
  [["ask", "--file", "a", "--profile", "Bad Name"]],
  [["ask", "--file", "a", "--source", "x"]],
  [["ask", "extra", "--file", "a"]],
  [["ask", "--question", "What changed?"]],
  [["ask", "--question", "-"]],
])(
  "ask refuses %j with usage",
  async (args) => {
    const result = await device.run(args);
    expect(result).toMatchObject({ code: 2, output: { reason: "invalid_arguments" } });
    expect(await sources()).toEqual([]);
  },
  60000,
);

test.each([
  { file: "-", stdin: " \n\t", reason: "invalid_source_plan", code: 2 },
  { file: "missing-question.txt", stdin: undefined, reason: "source_io_failed", code: 1 },
])(
  "ask refuses $reason without source or launch effects",
  async ({ file, stdin, reason, code }) => {
    const calls = await device.herdrCalls();
    const result = await device.run(["ask", "--file", file], { stdin });
    expect(result).toMatchObject({ code, output: { operation: "ask", reason } });
    expect(await sources()).toEqual([]);
    expect(await device.herdrCalls()).toEqual(calls);
  },
  60000,
);
