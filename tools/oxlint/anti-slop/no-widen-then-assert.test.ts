import { expect, test } from "bun:test";
import { lintProject } from "../check.ts";

const check = lintProject();

test("rejects immutable widening through aliases and destructured bindings", async () => {
  const invalid = await check(`
export function widen() {
  const { id } = { id: 1 };
  const widened: unknown = id;
  const indexed: Record<string, unknown> = { id: 1 };
  return [widened as number, indexed as Record<string, number>];
}
`);
  expect(invalid.codes.filter((code) => code === "anti-slop(no-widen-then-assert)")).toHaveLength(
    2,
  );
});

test("accepts precise values, boundary inputs, and reassigned bindings", async () => {
  const valid = await check("export const value = { id: 1 };");
  expect(valid.codes).toEqual([]);
  const reassigned = await check(
    "export function widen() { let value = 1; value = 2; const widened: unknown = value; return widened as number; }",
    { path: "lib/lint-probe.test.ts" },
  );
  expect(reassigned.codes).toEqual([]);
});
