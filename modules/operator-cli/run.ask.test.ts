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

test("ask registers a one-assignment report source and dispatches its worker in one step", async () => {
  const question = "Why does `next --wait` return ended sources?\n## Not a brief section";
  const result = await device.run(["ask", "--question", question]);
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
            completion: "report",
            resources: "pane",
            dependencies: [],
          },
        ],
      },
      launches: [{ assignment: data.assignment, state: "running", paneId: data.paneId }],
    },
  });

  // The question stays quoted, so its text cannot open a brief section.
  const brief = await Bun.file(data.brief).text();
  expect(brief).toContain(
    "> Why does `next --wait` return ended sources?\n> ## Not a brief section",
  );
  expect(brief).not.toContain("\n## Not a brief section");
  expect(brief).toContain("short conclusion");
  expect(brief).toContain("operator report submit");
  expect(await device.next(data.assignment)).toMatchObject([{ reason: "assignment_active" }]);

  // Acceptance works as for any report assignment.
  const report = await device.writeJson("report.json", {
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
  const first = await device.run(["ask", "--question", "Where is the brief written?"]);
  const second = await device.run(["ask", "--question", "Where is the brief written?"]);
  expect([first.code, second.code]).toEqual([0, 0]);
  expect(asked.parse(first.output).data.sourceId).not.toBe(
    asked.parse(second.output).data.sourceId,
  );
  expect(asked.parse(first.output).data.paneId).not.toBe(asked.parse(second.output).data.paneId);
}, 60000);

test("ask starts the worker with a named start profile", async () => {
  const result = await device.run(["ask", "--question", "What changed?", "--profile", "careful"]);
  expect(result.code, result.stderr).toBe(0);
  const data = asked.parse(result.output).data;
  const shown = await device.run(["source", "show", "--source", data.sourceId]);
  expect(shown.output).toMatchObject({
    data: { launches: [{ profile: "careful", reasoningEffort: "high" }] },
  });
}, 60000);

test("a question with no letters or digits gets a fixed assignment key", async () => {
  const result = await device.run(["ask", "--question", "???"]);
  expect(result.code, result.stderr).toBe(0);
  expect(result.output).toMatchObject({ data: { assignment: "question" } });
}, 60000);

test("a question that opens with a long token gets a key within the plan's limit", async () => {
  const result = await device.run(["ask", "--question", `${"a".repeat(250)} is what?`]);
  expect(result.code, result.stderr).toBe(0);
  expect(result.output).toMatchObject({ data: { assignment: "a".repeat(60) } });
}, 60000);

test("ask refuses an unknown profile and writes no source", async () => {
  const result = await device.run(["ask", "--question", "What changed?", "--profile", "missing"]);
  expect(result).toMatchObject({ code: 3, output: { reason: "source_profile_missing" } });
  expect(await sources()).toEqual([]);
  expect(await device.herdrCalls()).not.toContain("agent start");
}, 60000);

test.each([
  [["ask"]],
  [["ask", "--question"]],
  [["ask", "--question", "   "]],
  [["ask", "--question", "--profile"]],
  [["ask", "--question", "a", "--question", "b"]],
  [["ask", "--question", "a", "--profile", "Bad Name"]],
  [["ask", "--question", "a", "--source", "x"]],
  [["ask", "extra", "--question", "a"]],
])(
  "ask refuses %j with usage",
  async (args) => {
    const result = await device.run(args);
    expect(result).toMatchObject({ code: 2, output: { reason: "invalid_arguments" } });
    expect(await sources()).toEqual([]);
  },
  60000,
);
