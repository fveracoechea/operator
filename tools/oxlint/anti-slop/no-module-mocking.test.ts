import { expect, test } from "bun:test";
import { lintProject } from "../check.ts";

const check = lintProject();

test.each([
  'import { mock } from "bun:test"; mock.module("./target", () => ({}));',
  'import { mock as replace } from "bun:test"; replace["module"]("./target", () => ({}));',
  'import * as tests from "bun:test"; tests.mock.module("./target", () => ({}));',
])("rejects Bun module replacement %s", async (source) => {
  expect((await check(source)).codes).toContain("anti-slop(no-module-mocking)");
});

test("accepts function mocks and unrelated objects", async () => {
  const valid = await check(
    'import { mock } from "bun:test"; export const call = mock(() => 1); export const other = { module() { return 1; } }; other.module();',
  );
  expect(valid.codes).toEqual([]);
});

const rule = "anti-slop(no-module-mocking)";

async function flagged(lines: string[]): Promise<number[]> {
  const result = await check(lines.join("\n"), { path: "lib/lint-probe.test.ts" });
  return result.findings
    .filter((finding) => finding.endsWith(` ${rule}`))
    .map((finding) => Number.parseInt(finding, 10));
}

test("only Bun's mock, by any local, quoted, or namespace name, replaces a module", async () => {
  // Each import line is followed by the probe's blank line, so the calls start on line 13.
  expect(
    await flagged([
      'import { mock as named, test as other, "mock" as quoted, "test" as quotedOther } from "bun:test";',
      'import bunDefault, * as bun from "bun:test";',
      'import { mock as foreign } from "./assert.ts";',
      'import * as foreignSpace from "./assert.ts";',
      'import { expect } from "bun:test";',
      "interface named {}",
      "interface bun {}",
      'named.module("./a", () => ({}));',
      'quoted.module("./a", () => ({}));',
      'bun.mock.module("./a", () => ({}));',
      'other.module("./a", () => ({}));',
      'quotedOther.module("./a", () => ({}));',
      'bunDefault.module("./a", () => ({}));',
      'foreign.module("./a", () => ({}));',
      'foreignSpace.mock.module("./a", () => ({}));',
      'expect.mock.module("./a", () => ({}));',
      'undeclared.module("./a", () => ({}));',
      'undeclaredSpace.mock.module("./a", () => ({}));',
      'function local() { return { module() {} }; } local().module("./a");',
      'export function given(mock, space) { mock.module("./a"); space.mock.module("./a"); }',
      'const near = { mock: { module() {} } }; near.mock.module("./a");',
    ]),
  ).toEqual([13, 14, 15]);
});

test("the finding names the fix topic", async () => {
  const result = await check('import { mock } from "bun:test"; mock.module("./a", () => ({}));');
  expect(result.stdout).toContain(
    "Replace dependencies at their public interface or external tool boundary, not with mock.module. See lint-fixes/test-doubles.md.",
  );
});
