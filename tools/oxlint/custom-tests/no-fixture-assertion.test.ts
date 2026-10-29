import { expect, test } from "bun:test";
import { lintProject } from "../check.ts";

const check = lintProject();

// A binding cycle comes first, so a rule that never returns hits the lint time limit early.
test("a binding cycle is not a fixture", async () => {
  const result = await check(
    'import { expect } from "bun:test"; const loopA: number = loopB; const loopB: number = loopA; expect(loopA).toBe(1);',
    { path: "lib/lint-probe.test.ts" },
  );
  expect(result.codes).not.toContain("custom-tests(no-fixture-assertion)");
});

test.each([
  'import { expect } from "bun:test"; const fixture = { id: 1 }; expect(fixture.id).toBe(1);',
  'import { expect as verify } from "bun:test"; const fixture = [1]; const alias = fixture; verify(alias).toEqual([1]);',
])("rejects assertions on local fixture data %s", async (source) => {
  expect((await check(source)).codes).toContain("custom-tests(no-fixture-assertion)");
});

test.each([
  'import { expect } from "bun:test"; const value = JSON.parse("1") as unknown; expect(value).toBe(1);',
  'import { expect } from "bun:test"; const observed: string[] = []; observed.push(String(1)); expect(observed).toEqual(["1"]);',
  'import { expect } from "bun:test"; const observed = String(1); expect([observed]).toEqual(["1"]);',
  'import { expect } from "bun:test"; declare function update(input: { id: number }): void; const input = { id: 1 }; update(input); expect(input.id).toBe(2);',
])("accepts observations and mutation checks %s", async (source) => {
  expect((await check(source, { path: "lib/lint-probe.test.ts" })).codes).toEqual([]);
});

const rule = "custom-tests(no-fixture-assertion)";

async function flagged(lines: string[]): Promise<number[]> {
  const result = await check(lines.join("\n"), { path: "lib/lint-probe.test.ts" });
  return result.findings
    .filter((finding) => finding.endsWith(` ${rule}`))
    .map((finding) => Number.parseInt(finding, 10));
}

test("only fully literal objects and arrays, and their const aliases, are fixtures", async () => {
  expect(
    await flagged([
      'import { expect } from "bun:test";',
      "",
      "const all = { id: 1, list: [1, 2] }; expect(all).toEqual({});",
      "const mixed = { id: 1, value: String(1) }; expect(mixed).toEqual({});",
      "const base = { id: 1 }; const spread = { ...base }; expect(spread).toEqual({});",
      "const called = { value: String(1) }; expect(called).toEqual({});",
      "const pair = [1, String(1)]; expect(pair).toEqual([]);",
      "const sparse = [1, , 2]; expect(sparse).toEqual([]);",
      "expect(String(1)).toBe(1);",
      "expect(undeclared).toBe(1);",
      "export function given(param: number) { expect(param).toBe(1); }",
      "let changed = 1; changed = 2; expect(changed).toBe(1);",
    ]),
  ).toEqual([3]);
});

test("only a method call on a fixture is observed behavior", async () => {
  expect(
    await flagged([
      'import { expect } from "bun:test";',
      "",
      "const read = { id: 1 }; read.id; expect(read).toEqual({});",
      "const cast = { id: 1 }; (cast as never)(); expect(cast).toEqual({});",
      "const made = { id: 1 }; new made.id(); expect(made).toEqual({});",
      "const method = { id: 1 }; method.id(); expect(method).toEqual({});",
    ]),
  ).toEqual([3, 4, 5]);
});

test("only Bun's expect, by any local or quoted name, is an assertion", async () => {
  expect(
    await flagged([
      'import { expect as verify, test as probe, "expect" as quoted, "test" as quotedTest } from "bun:test";',
      'import other from "bun:test";',
      'import { expect as foreign } from "./assert.ts";',
      "",
      "const one = { id: 1 }; verify(one).toEqual({});",
      "const two = { id: 1 }; quoted(two).toEqual({});",
      'const three = { id: 1 }; probe("name", three);',
      'const four = { id: 1 }; quotedTest("name", four);',
      "const five = { id: 1 }; other(five);",
      "const six = { id: 1 }; foreign(six).toEqual({});",
      "function local(value: object) { return value; }",
      "const seven = { id: 1 }; local(seven);",
    ]),
    // Each import line is followed by the probe's blank line, so the cases start on line 7.
  ).toEqual([7, 8]);
});

test("the finding names the fix topic", async () => {
  const result = await check(
    'import { expect } from "bun:test"; const fixture = { id: 1 }; expect(fixture).toEqual({});',
    { path: "lib/lint-probe.test.ts" },
  );
  expect(result.stdout).toContain(
    "This assertion reads its own fixture. Call the code under test and assert on its result or effects. See lint-fixes/test-doubles.md.",
  );
});
