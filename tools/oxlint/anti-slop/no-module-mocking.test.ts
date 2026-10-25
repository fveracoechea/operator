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
