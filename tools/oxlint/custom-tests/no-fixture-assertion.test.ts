import { expect, test } from "bun:test";
import { lintProject } from "../check.ts";

const check = lintProject();

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
