import { afterAll, afterEach, expect, spyOn, test } from "bun:test";
// Bun has no temporary-directory, recursive removal, or symlink API.
import { mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { z } from "zod";
import { runMutationPreflight } from "./mutation-preflight.ts";
import type { MutationEvent } from "./mutation-run.ts";

const root = await mkdtemp(`${tmpdir()}/450-preflight-`);
afterAll(async () => rm(root, { recursive: true, force: true }));
const human = spyOn(console, "error").mockImplementation(() => {});
afterEach(() => human.mockClear());
afterAll(() => human.mockRestore());

test.each([
  { eligible: true, identity: "current-inputs", lookup: "hit" },
  { eligible: false, reason: "unsupported-test-command", lookup: "not-checked" },
] as const)(
  "preflight publishes %j before measuring and never substitutes cached verdicts",
  async (decision) => {
    const events: MutationEvent[] = [];
    const unit = {
      name: "owner.ts",
      source: "",
      patterns: ["owner.ts"],
      tests: ["./owner.test.ts"],
    };
    let executions = 0;
    const code = await runMutationPreflight(
      { units: [unit], skipped: 0 },
      async () => {
        executions++;
        expect(events.at(-1)).toMatchObject({
          mode: "preflight",
          type: "reuse-decision",
          state: { units: [{ reuse: decision }] },
        });
        return [];
      },
      "preflight-reuse",
      (event) => events.push(event),
      async () => (decision.eligible ? { decision, results: [] } : { decision }),
    );
    expect(code).toBe(3);
    expect(executions).toBe(1);
    expect(events.at(-1)).toMatchObject({
      mode: "preflight",
      type: "run-completed",
      state: {
        status: "incomplete",
        units: [{ status: "unrun", reuse: decision, mutants: null, progress: { reused: 0 } }],
      },
    });
  },
);

test("preflight records measured costs but leaves all mutations unqualified", async () => {
  const started = Date.now();
  const events: MutationEvent[] = [];
  const first = { name: "a.ts", source: "", patterns: ["a.ts:2-4"], tests: ["./a.test.ts"] };
  const second = { name: "b.ts", source: "", patterns: ["b.ts"], tests: ["./b.test.ts"] };
  expect(
    await runMutationPreflight(
      { units: [first, second], skipped: 2 },
      async (unit, progress) => {
        progress({
          completed: 0,
          total: unit.name === "a.ts" ? 4 : null,
          reused: 0,
          baselineMs: 25,
          overheadMs: 10,
        });
        return [];
      },
      "measured",
      (event) => events.push(event),
    ),
  ).toBe(3);
  expect(events.map((event) => event.type)).toEqual([
    "run-started",
    "unit-started",
    "progress",
    "unit-completed",
    "unit-started",
    "progress",
    "unit-completed",
    "run-completed",
  ]);
  expect(events.map((event) => event.sequence)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  expect(events[0]?.state.units.map((unit) => unit.status)).toEqual(["unrun", "unrun"]);
  expect(events[0]?.state.status).toBe("running");
  expect(events[1]?.state.activeUnit).toBe("a.ts");
  expect(events[1]?.state.units[0]?.status).toBe("running");
  expect(events[1]?.state.units[0]?.preflight).toEqual({
    baselineMs: null,
    overheadMs: null,
    mutationCount: null,
    estimatedMs: null,
    assumptions: ["Baseline timing or mutation count is unknown."],
  });
  const final = events.at(-1);
  expect(final).toMatchObject({
    version: 1,
    mode: "preflight",
    runId: "measured",
    state: { status: "incomplete", activeUnit: null, skipped: 2, completedUnits: 0 },
  });
  expect(final?.elapsedMs).toBeGreaterThanOrEqual(0);
  expect(final?.elapsedMs).toBeLessThanOrEqual(Date.now() - started);
  expect(human.mock.calls).toEqual([
    [
      "a.ts: measured preflight baseline 25ms, overhead 10ms, mutation count 4, estimated cost 125ms. Baseline-only evidence, not mutation qualification. Assumptions: One baseline plus one full test-suite duration per mutant, sequential execution, no reuse, no startup or instrumentation overhead. Bailout and timeout behavior may change actual cost.",
    ],
    [
      "b.ts: measured preflight baseline 25ms, overhead 10ms, mutation count unknown, estimated cost unknownms. Baseline-only evidence, not mutation qualification. Assumptions: Baseline timing or mutation count is unknown.",
    ],
  ]);
  expect(final?.state.units).toEqual([
    {
      name: "a.ts",
      patterns: ["a.ts:2-4"],
      tests: ["./a.test.ts"],
      status: "unrun",
      mutants: null,
      progress: { completed: 0, total: null, reused: 0 },
      preflight: {
        baselineMs: 25,
        overheadMs: 10,
        mutationCount: 4,
        estimatedMs: 125,
        assumptions: [
          "One baseline plus one full test-suite duration per mutant, sequential execution, no reuse, no startup or instrumentation overhead. Bailout and timeout behavior may change actual cost.",
        ],
      },
    },
    {
      name: "b.ts",
      patterns: ["b.ts"],
      tests: ["./b.test.ts"],
      status: "unrun",
      mutants: null,
      progress: { completed: 0, total: null, reused: 0 },
      preflight: {
        baselineMs: 25,
        overheadMs: 10,
        mutationCount: null,
        estimatedMs: null,
        assumptions: ["Baseline timing or mutation count is unknown."],
      },
    },
  ]);
});

test("preflight stops on baseline failure and preserves prior measurements", async () => {
  const events: MutationEvent[] = [];
  const units = ["done", "broken", "later"].map((name) => ({
    name: `${name}.ts`,
    source: "",
    patterns: [`${name}.ts`],
    tests: [`./${name}.test.ts`],
  }));
  expect(
    await runMutationPreflight(
      { units, skipped: 0 },
      async (unit, progress) => {
        if (unit.name !== "done.ts") return await Promise.reject(new Error("baseline failed"));
        progress({ completed: 0, total: null, reused: 0 });
        return [];
      },
      "partial",
      (event) => events.push(event),
    ),
  ).toBe(3);
  const final = events.at(-1);
  expect(events.map((event) => event.type)).toEqual([
    "run-started",
    "unit-started",
    "progress",
    "unit-completed",
    "unit-started",
    "unit-interrupted",
    "run-completed",
  ]);
  expect(final?.state.units.map((unit) => unit.status)).toEqual(["unrun", "interrupted", "unrun"]);
  expect(final?.state.units[0]?.preflight).toEqual({
    baselineMs: null,
    overheadMs: null,
    mutationCount: null,
    estimatedMs: null,
    assumptions: ["Baseline timing or mutation count is unknown."],
  });
  expect(final?.state.units[1]?.error).toBe("Error: baseline failed");
  expect(final?.state.units[2]?.preflight).toBeUndefined();
  expect(human.mock.calls).toEqual([
    [
      "done.ts: measured preflight baseline unknownms, overhead unknownms, mutation count unknown, estimated cost unknownms. Baseline-only evidence, not mutation qualification. Assumptions: Baseline timing or mutation count is unknown.",
    ],
  ]);
  const missing: MutationEvent[] = [];
  expect(
    await runMutationPreflight(
      {
        units: [{ name: "missing.ts", source: "", patterns: ["missing.ts"], tests: [] }],
        skipped: 0,
      },
      async () => Promise.reject(new Error("must not execute")),
      "missing",
      (event) => missing.push(event),
    ),
  ).toBe(3);
  expect(missing.at(-1)?.state.units[0]).toMatchObject({
    status: "interrupted",
    error: "No direct beside-tests.",
  });
  expect(missing.map((event) => event.type)).toEqual([
    "run-started",
    "unit-started",
    "unit-interrupted",
    "run-completed",
  ]);
});

test("measured preflight executes only the baseline and never records mutation qualification", async () => {
  const receipt = `${root}/executions`;
  const cwd = `${root}/source`;
  await Bun.write(
    `${cwd}/package.json`,
    JSON.stringify({ scripts: { test: "bun test --isolate" } }),
  );
  await Bun.write(`${cwd}/count.ts`, "export function count(n: number) { return n + 1; }\n");
  await Bun.write(
    `${cwd}/count.test.ts`,
    `import {test, expect} from "bun:test";
import {count} from "./count.ts";
test("baseline", async () => {
  await Bun.write(${JSON.stringify(receipt)}, (await Bun.file(${JSON.stringify(receipt)}).text().catch(() => "")) + "run\\n");
  expect(count(1)).toBe(2);
});`,
  );
  await symlink(
    path.dirname(path.dirname(Bun.resolveSync("zod/package.json", import.meta.dir))),
    `${cwd}/node_modules`,
  );
  const child = Bun.spawn(
    [process.execPath, `${import.meta.dir}/mutate.ts`, "--preflight", "--json", "count.ts"],
    {
      cwd,
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  expect(code, stderr).toBe(3);
  expect(await Bun.file(receipt).exists(), stderr + stdout).toBe(true);
  expect(await Bun.file(receipt).text()).toBe("run\n");
  const final = z
    .object({
      mode: z.literal("preflight"),
      type: z.literal("run-completed"),
      state: z.object({
        status: z.literal("incomplete"),
        completedUnits: z.literal(0),
        units: z.array(
          z.object({
            status: z.literal("unrun"),
            mutants: z.null(),
            preflight: z.object({
              baselineMs: z.number().nonnegative(),
              overheadMs: z.number().nonnegative(),
              mutationCount: z.null(),
              estimatedMs: z.null(),
              assumptions: z.array(z.string()),
            }),
          }),
        ),
      }),
    })
    .parse(JSON.parse(stdout.trim().split("\n").at(-1) ?? ""));
  expect(final.state.units).toHaveLength(1);
  expect(final.state.units[0]?.preflight.assumptions).toContain(
    "Baseline timing or mutation count is unknown.",
  );
  expect(stderr).toContain("mutation count unknown");
  expect(stderr).toContain("not mutation qualification");
}, 20_000);
