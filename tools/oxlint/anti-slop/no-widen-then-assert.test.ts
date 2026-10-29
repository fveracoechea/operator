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

test("an object-widened binding asserted back to a definite object type is flagged", async () => {
  const result = await check(
    [
      "export function probe(parameter: unknown, untyped) {",
      "  const value: object = { id: 1 };",
      "  value as { id: number };",
      "  value as {};",
      "  value as { a: 1 } & { b: 2 };",
      "  value as { a: 1 } & string;",
      "  value as readonly string[];",
      "  value as keyof { a: 1 };",
      "  value as string[];",
      "  value as new () => object;",
      "  value as () => void;",
      '  value as { [K in "a"]: 1 };',
      "  value as object & { id: 1 };",
      "  value as [number];",
      "  value as Named;",
      "  parameter as string;",
      "  const widened: unknown = untyped;",
      "  return widened as string;",
      "}",
    ].join("\n"),
  );
  expect(
    result.findings
      .filter((finding) => finding.endsWith(" anti-slop(no-widen-then-assert)"))
      .map((finding) => Number.parseInt(finding, 10)),
  ).toEqual([3, 5, 7, 9, 10, 11, 12, 13, 14]);
  expect(result.stdout).toContain(
    'Binding \\"value\\" discards type evidence and later recreates it with an assertion. Keep the precise type from initialization through use; parse boundary input once. See lint-fixes/type-assertions.md.',
  );
});
