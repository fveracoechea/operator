import { expect, test } from "bun:test";
import {
  mutationEventSchema,
  runMutationUnits,
  type MutationResult,
  type MutationEvent,
} from "./mutation-run.ts";

const unit = {
  name: "count.ts",
  source: "export const n = 1;",
  tests: ["./count.test.ts"],
  patterns: ["count.ts:1-1"],
};
const killed: MutationResult = {
  id: "1",
  status: "Killed",
  mutatorName: "ArithmeticOperator",
  location: { start: { line: 1, column: 18 }, end: { line: 1, column: 19 } },
  replacement: "0",
};

test("worker event schema validates every evidence field including optional nested measurements", async () => {
  const events: MutationEvent[] = [];
  await runMutationUnits(
    { units: [unit], skipped: 0 },
    async () => [killed],
    { log() {}, error() {} },
    { event: (event) => events.push(event) },
  );
  for (const event of events) expect(mutationEventSchema.safeParse(event).success).toBe(true);
  const terminal = events.at(-1);
  if (!terminal) return expect.unreachable("missing terminal event");
  const rich = {
    ...terminal,
    mode: "preflight",
    admission: { identity: "identity", current: null, reason: "measured" },
    state: {
      ...terminal.state,
      units: [
        {
          ...terminal.state.units[0],
          error: "diagnostic",
          progress: { completed: 1, total: 1, reused: 1, baselineMs: 1, overheadMs: 2 },
          preflight: {
            baselineMs: 1,
            overheadMs: 2,
            mutationCount: 3,
            estimatedMs: 4,
            assumptions: ["sequential"],
          },
        },
      ],
    },
  };
  expect(mutationEventSchema.safeParse(rich).success).toBe(true);
  expect(
    mutationEventSchema.safeParse({ ...rich, admission: { identity: "i", current: true } }).success,
  ).toBe(true);
  expect(
    mutationEventSchema.safeParse({ ...rich, admission: { identity: "i", current: false } })
      .success,
  ).toBe(true);
  for (const status of ["running", "passed", "failed", "incomplete"])
    expect(
      mutationEventSchema.safeParse({ ...rich, state: { ...rich.state, status } }).success,
      status,
    ).toBe(true);
  for (const status of ["unrun", "running", "passed", "failed", "interrupted", "reused"])
    expect(
      mutationEventSchema.safeParse({
        ...rich,
        state: { ...rich.state, units: [{ ...rich.state.units[0], status }] },
      }).success,
      status,
    ).toBe(true);
  for (const type of [
    "run-started",
    "unit-started",
    "progress",
    "unit-completed",
    "unit-interrupted",
    "run-completed",
  ])
    expect(mutationEventSchema.safeParse({ ...rich, type }).success, type).toBe(true);
  for (const key of [
    "version",
    "runId",
    "sequence",
    "type",
    "elapsedMs",
    "state",
    "status",
    "activeUnit",
    "completedUnits",
    "skipped",
    "units",
    "name",
    "tests",
    "patterns",
    "mutants",
    "progress",
    "completed",
    "total",
    "reused",
    "id",
    "mutatorName",
    "location",
    "start",
    "end",
    "line",
    "column",
    "replacement",
  ]) {
    const missing: unknown = JSON.parse(
      JSON.stringify(terminal).replaceAll(new RegExp(`"${key}":`, "g"), `"missing-${key}":`),
    );
    expect(mutationEventSchema.safeParse(missing).success, key).toBe(false);
  }
  for (const value of [
    { ...terminal, mode: "mutation" },
    { ...terminal, admission: { identity: "id", current: "yes" } },
    {
      ...terminal,
      state: { ...terminal.state, units: [{ ...terminal.state.units[0], error: 1 }] },
    },
    {
      ...terminal,
      state: {
        ...terminal.state,
        units: [
          {
            ...terminal.state.units[0],
            preflight: {
              baselineMs: 1,
              overheadMs: 1,
              mutationCount: 1,
              estimatedMs: "unknown",
              assumptions: [],
            },
          },
        ],
      },
    },
    {
      ...terminal,
      state: {
        ...terminal.state,
        units: [
          { ...terminal.state.units[0], progress: { completed: -1, total: null, reused: 0 } },
        ],
      },
    },
  ])
    expect(mutationEventSchema.safeParse(value).success).toBe(false);
});

test("an empty selection qualifies without provisioning an engine", async () => {
  const stdout: string[] = [];
  const code = await runMutationUnits(
    { units: [], skipped: 0 },
    () => {
      return expect.unreachable("must not execute");
    },
    {
      log: (line) => stdout.push(line),
      error: () => {
        expect.unreachable("must not report errors");
      },
    },
  );
  expect(code).toBe(0);
  expect(stdout).toEqual([
    "Mutation summary: 0 survivors, 0 untested, 0 incomplete, 0 killed, 0 ignored, 0 skipped. See docs/agents/testing/mutation-testing.md.",
  ]);
});

test.each([
  { status: "Killed", expected: "reused", code: 0 },
  { status: "Survived", expected: "failed", code: 2 },
  { status: "NoCoverage", expected: "failed", code: 2 },
])(
  "whole-unit $status reuse retains truthful terminal outcomes",
  async ({ status, expected, code }) => {
    const events: MutationEvent[] = [];
    const result = await runMutationUnits(
      { units: [unit], skipped: 0 },
      () => expect.unreachable("completed reusable work must not execute"),
      { log() {}, error() {} },
      {
        reuse: async () => [{ ...killed, status }],
        event: (event) => events.push(event),
      },
    );
    expect(result).toBe(code);
    expect(events.at(-1)?.state).toMatchObject({
      completedUnits: 1,
      activeUnit: null,
      status: code === 0 ? "passed" : "failed",
      units: [
        {
          status: expected,
          mutants: [{ status }],
          progress: { total: 1, completed: 1, reused: 1 },
        },
      ],
    });
  },
);

test.each([
  {
    status: "Killed",
    code: 0,
    counts: "0 survivors, 0 untested, 0 incomplete, 1 killed, 0 ignored",
  },
  {
    status: "Survived",
    code: 2,
    counts: "1 survivors, 0 untested, 0 incomplete, 0 killed, 0 ignored",
  },
  {
    status: "NoCoverage",
    code: 2,
    counts: "0 survivors, 1 untested, 0 incomplete, 0 killed, 0 ignored",
  },
  {
    status: "Ignored",
    code: 0,
    counts: "0 survivors, 0 untested, 0 incomplete, 0 killed, 1 ignored",
  },
  {
    status: "RuntimeError",
    code: 3,
    counts: "0 survivors, 0 untested, 1 incomplete, 0 killed, 0 ignored",
  },
  {
    status: "CompileError",
    code: 3,
    counts: "0 survivors, 0 untested, 1 incomplete, 0 killed, 0 ignored",
  },
  {
    status: "Pending",
    code: 3,
    counts: "0 survivors, 0 untested, 1 incomplete, 0 killed, 0 ignored",
  },
])("$status has its own qualification meaning", async ({ status, code, counts }) => {
  const stdout: string[] = [];
  const stderr: string[] = [];
  expect(
    await runMutationUnits(
      { units: [unit], skipped: 2 },
      async () => [{ ...killed, status, statusReason: "engine detail" }],
      { log: (line) => stdout.push(line), error: (line) => stderr.push(line) },
    ),
  ).toBe(code);
  expect(stdout.at(-1)).toBe(
    `Mutation summary: ${counts}, 2 skipped. See docs/agents/testing/mutation-testing.md.`,
  );
  if (code === 3) {
    expect(stderr).toEqual([`count.ts:1: incomplete: ${status}: engine detail`]);
  } else {
    expect(stderr).toEqual([]);
  }
  if (status === "NoCoverage") expect(stdout[0]).toBe("count.ts:1: untested: ArithmeticOperator");
  if (status === "Killed") expect(stdout).toHaveLength(1);
});

test("coordination awaits each engine result and stops after a failed unit by default", async () => {
  const stdout: string[] = [];
  const executed: unknown[] = [];
  const second = {
    ...unit,
    name: "second.ts",
    patterns: ["second.ts"],
    tests: ["./second.test.ts"],
  };
  let active = false;
  const code = await runMutationUnits(
    { units: [unit, second], skipped: 1 },
    async (selected) => {
      expect(active).toBe(false);
      active = true;
      executed.push(selected);
      await Promise.resolve();
      active = false;
      return [{ ...killed, status: selected.name === "count.ts" ? "Survived" : "Killed" }];
    },
    { log: (line) => stdout.push(line), error: () => {} },
  );
  expect(code).toBe(2);
  expect(executed).toEqual([unit]);
  expect(stdout.at(-1)).toBe(
    "Mutation summary: 1 survivors, 0 untested, 0 incomplete, 0 killed, 0 ignored, 1 skipped. See docs/agents/testing/mutation-testing.md.",
  );
});

test("engine failures propagate without inventing results or starting later work", async () => {
  const stdout: string[] = [];
  const executed: string[] = [];
  const failure = new Error("baseline failed");
  const events: MutationEvent[] = [];
  await expect(
    runMutationUnits(
      { units: [unit, { ...unit, name: "later.ts" }], skipped: 0 },
      async (selected) => {
        executed.push(selected.name);
        return Promise.reject(failure);
      },
      { log: (line) => stdout.push(line), error: (line) => stdout.push(line) },
      { event: (event) => events.push(event) },
    ),
  ).rejects.toBe(failure);
  expect(executed).toEqual(["count.ts"]);
  expect(stdout).toEqual([]);
  expect(events.at(-1)).toMatchObject({
    type: "run-completed",
    state: {
      status: "incomplete",
      completedUnits: 0,
      activeUnit: null,
      units: [
        { status: "interrupted", error: "Error: baseline failed", mutants: null },
        { status: "unrun", mutants: null },
      ],
    },
  });
});

test("engine verdicts preserve counts, diagnostics, and incomplete exit precedence", async () => {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const code = await runMutationUnits(
    {
      units: [
        {
          name: "pick.ts",
          source: "prefix `a`\nsecond\n",
          tests: ["./pick.test.ts"],
          patterns: ["pick.ts:1-2"],
        },
      ],
      skipped: 0,
    },
    async () => [
      {
        id: "survivor",
        status: "Survived",
        mutatorName: "StringLiteral",
        location: { start: { line: 1, column: 8 }, end: { line: 2, column: 4 } },
        replacement: "`b`\nnext",
      },
      {
        id: "ignored",
        status: "Ignored",
        mutatorName: "StringLiteral",
        location: { start: { line: 1, column: 8 }, end: { line: 1, column: 11 } },
        replacement: "``",
        statusReason: "equivalent: fixture",
      },
      {
        id: "timeout",
        status: "Timeout",
        mutatorName: "BlockStatement",
        location: { start: { line: 2, column: 1 }, end: { line: 2, column: 7 } },
        replacement: "{}",
      },
      {
        id: "killed",
        status: "Killed",
        mutatorName: "StringLiteral",
        location: { start: { line: 1, column: 8 }, end: { line: 1, column: 11 } },
        replacement: "``",
      },
    ],
    { log: (line) => stdout.push(line), error: (line) => stderr.push(line) },
  );
  expect(code).toBe(3);
  expect(stdout).toEqual([
    "pick.ts:1: survived: StringLiteral: `\\`a\\`\\nsec` to `\\`b\\`\\nnext`",
    '{"unit":"pick.ts","id":"ignored","status":"Ignored","mutatorName":"StringLiteral","location":{"start":{"line":1,"column":8},"end":{"line":1,"column":11}},"replacement":"``","original":"\\\\`a\\\\`","statusReason":"equivalent: fixture"}',
    "Mutation summary: 1 survivors, 0 untested, 1 incomplete, 1 killed, 1 ignored, 0 skipped. See docs/agents/testing/mutation-testing.md.",
  ]);
  expect(stderr).toEqual(["pick.ts:2: incomplete: Timeout: no result"]);
});

test("units without direct tests fail qualification without executing the engine", async () => {
  const output: string[] = [];
  const events: MutationEvent[] = [];
  const code = await runMutationUnits(
    {
      units: [{ name: "private.ts", source: "", patterns: ["private.ts"], tests: [] }],
      skipped: 4,
    },
    () => {
      return expect.unreachable("must not provision the engine");
    },
    { log: (line) => output.push(line), error: () => {} },
    { event: (event) => events.push(event) },
  );
  expect(code).toBe(2);
  expect(output).toEqual([
    "private.ts: untested. Add a direct beside-test.",
    "Mutation summary: 0 survivors, 1 untested, 0 incomplete, 0 killed, 0 ignored, 4 skipped. See docs/agents/testing/mutation-testing.md.",
  ]);
  expect(events.at(-1)?.state.units[0]).toMatchObject({ status: "failed" });
});

test("keep-going preserves failure and publishes recoverable selected and completed evidence", async () => {
  const events: MutationEvent[] = [];
  let time = 100;
  expect(
    await runMutationUnits(
      { units: [unit, { ...unit, name: "later.ts" }], skipped: 2 },
      async () => {
        time += 25;
        return [{ ...killed, status: "Survived" }];
      },
      { log: () => {}, error: () => {} },
      { keepGoing: true, runId: "example", now: () => time, event: (event) => events.push(event) },
    ),
  ).toBe(2);
  expect(events.map((event) => event.type)).toEqual([
    "run-started",
    "unit-started",
    "unit-completed",
    "unit-started",
    "unit-completed",
    "run-completed",
  ]);
  expect(events[0]).toMatchObject({
    version: 1,
    runId: "example",
    sequence: 0,
    elapsedMs: 0,
    state: {
      status: "running",
      activeUnit: null,
      completedUnits: 0,
      skipped: 2,
      units: [
        { name: "count.ts", status: "unrun", tests: ["./count.test.ts"], mutants: null },
        { name: "later.ts", status: "unrun", mutants: null },
      ],
    },
  });
  expect(events[1]).toMatchObject({ state: { activeUnit: "count.ts" } });
  expect(events.at(-1)).toMatchObject({
    elapsedMs: 50,
    sequence: 5,
    state: {
      status: "failed",
      activeUnit: null,
      completedUnits: 2,
      units: [{ status: "failed", mutants: [{ status: "Survived" }] }, { status: "failed" }],
    },
  });
  expect(events[0]?.state.units[0]?.status).toBe("unrun");
});

test.each(["NoCoverage", "Timeout", "Survived"])(
  "a %s verdict leaves later work unrun",
  async (status) => {
    const events: MutationEvent[] = [];
    expect(
      await runMutationUnits(
        { units: [unit, { ...unit, name: "unrun.ts" }], skipped: 0 },
        async () => [{ ...killed, status }],
        { log: () => {}, error: () => {} },
        { event: (event) => events.push(event) },
      ),
    ).toBe(status === "Timeout" ? 3 : 2);
    expect(events.at(-1)?.state).toMatchObject({
      status: status === "Timeout" ? "incomplete" : "failed",
      completedUnits: 1,
      activeUnit: null,
      units: [{ status: "failed" }, { status: "unrun", mutants: null }],
    });
  },
);

test("keep-going preserves completed evidence across an interrupted unit and continues diagnostics", async () => {
  const events: MutationEvent[] = [];
  const errors: string[] = [];
  expect(
    await runMutationUnits(
      { units: [unit, { ...unit, name: "broken.ts" }, { ...unit, name: "last.ts" }], skipped: 0 },
      async (selected) =>
        selected.name === "broken.ts" ? Promise.reject(new Error("baseline failed")) : [killed],
      { log: () => {}, error: (line) => errors.push(line) },
      { keepGoing: true, event: (event) => events.push(event) },
    ),
  ).toBe(3);
  expect(events.at(-1)?.state).toMatchObject({
    status: "incomplete",
    completedUnits: 2,
    activeUnit: null,
    units: [
      { status: "passed", mutants: [killed] },
      { status: "interrupted", error: "Error: baseline failed", mutants: null },
      { status: "passed", mutants: [killed] },
    ],
  });
  expect(errors).toEqual(["Mutation execution incomplete: Error: baseline failed"]);
  expect(events.filter((event) => event.type === "unit-interrupted")).toHaveLength(1);
});

test("passed units continue by default and expose engine progress without changing verdicts", async () => {
  const events: MutationEvent[] = [];
  expect(
    await runMutationUnits(
      { units: [unit, { ...unit, name: "next.ts" }], skipped: 0 },
      async (_unit, progress) => {
        progress({ completed: 1, total: 5, reused: 2 });
        return [killed];
      },
      { log: () => {}, error: () => {} },
      { event: (event) => events.push(event) },
    ),
  ).toBe(0);
  expect(events.filter((event) => event.type === "progress")).toHaveLength(2);
  expect(events[2]).toMatchObject({
    state: {
      units: [
        { status: "running", progress: { completed: 1, total: 5, reused: 2 } },
        { status: "unrun", progress: { completed: 0, total: null, reused: 0 } },
      ],
    },
  });
  expect(events.at(-1)?.state).toMatchObject({
    status: "passed",
    completedUnits: 2,
    units: [
      { status: "passed", progress: { completed: 1, total: 1, reused: 2 } },
      { status: "passed" },
    ],
  });
});

test("active units emit timed heartbeats and stop emitting once execution ends", async () => {
  const result = Promise.withResolvers<MutationResult[]>();
  const events: MutationEvent[] = [];
  const pending = runMutationUnits(
    { units: [unit], skipped: 0 },
    async () => result.promise,
    { log: () => {}, error: () => {} },
    { progressIntervalMs: 5, event: (event) => events.push(event) },
  );
  try {
    await Bun.sleep(40);
    expect(events[0]?.state.units[0]?.progress).toEqual({ completed: 0, total: null, reused: 0 });
    expect(events[1]?.state.units[0]?.status).toBe("running");
    expect(events.some((event) => event.type === "progress")).toBe(true);
  } finally {
    result.resolve([killed]);
    await pending;
  }
  const count = events.length;
  await Bun.sleep(40);
  expect(events).toHaveLength(count);
  expect(events.at(-1)?.state.status).toBe("passed");
});
