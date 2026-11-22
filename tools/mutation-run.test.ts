import { expect, test } from "bun:test";
import { runMutationUnits, type MutationResult } from "./mutation-run.ts";

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

test("coordination awaits each engine result and continues after a failed unit", async () => {
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
  expect(executed).toEqual([unit, second]);
  expect(stdout.at(-1)).toBe(
    "Mutation summary: 1 survivors, 0 untested, 0 incomplete, 1 killed, 0 ignored, 1 skipped. See docs/agents/testing/mutation-testing.md.",
  );
});

test("engine failures propagate without inventing results or starting later work", async () => {
  const stdout: string[] = [];
  const executed: string[] = [];
  const failure = new Error("baseline failed");
  await expect(
    runMutationUnits(
      { units: [unit, { ...unit, name: "later.ts" }], skipped: 0 },
      async (selected) => {
        executed.push(selected.name);
        return Promise.reject(failure);
      },
      { log: (line) => stdout.push(line), error: (line) => stdout.push(line) },
    ),
  ).rejects.toBe(failure);
  expect(executed).toEqual(["count.ts"]);
  expect(stdout).toEqual([]);
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
  const code = await runMutationUnits(
    {
      units: [{ name: "private.ts", source: "", patterns: ["private.ts"], tests: [] }],
      skipped: 4,
    },
    () => {
      return expect.unreachable("must not provision the engine");
    },
    { log: (line) => output.push(line), error: () => {} },
  );
  expect(code).toBe(2);
  expect(output).toEqual([
    "private.ts: untested. Add a direct beside-test.",
    "Mutation summary: 0 survivors, 1 untested, 0 incomplete, 0 killed, 0 ignored, 4 skipped. See docs/agents/testing/mutation-testing.md.",
  ]);
});
