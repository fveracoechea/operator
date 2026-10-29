import { expect, test } from "bun:test";
import { lintProject } from "../check.ts";

const check = lintProject();

test.each([
  "export type Hidden = unknown;",
  "type Hidden = unknown; export type Again = Hidden;",
  "export type Hidden = string | unknown;",
])("rejects hidden unknown %s", async (source) => {
  expect((await check(source)).codes).toContain("anti-slop(no-unknown-type-aliases)");
});

test("accepts domain types and explicit unknown parse boundaries", async () => {
  const valid = await check(
    'export type Item = { id: string; cause?: unknown }; export function isText(input: unknown): input is string { return typeof input === "string"; }',
  );
  expect(valid.codes).toEqual([]);
});

test("rejects each alias in a chain rather than only its unknown declaration", async () => {
  const invalid = await check("type Hidden = unknown; export type Again = Hidden;");
  expect(
    invalid.codes.filter((code) => code === "anti-slop(no-unknown-type-aliases)"),
  ).toHaveLength(2);
});

test("follows local aliases once, across value and type bindings that share a name", async () => {
  const result = await check(
    [
      "type Hidden = unknown;",
      "type Again = Hidden;",
      "type Either = string | unknown;",
      "type Wrapped = (unknown);",
      "type Missing = NotDeclared;",
      "type Loop = Loop | string;",
      "const Twin = 1; type Twin = unknown;",
      "type UsesTwin = Twin;",
      "type Plain = string; type UsesPlain = Plain;",
      "type Box<T> = T; type Item = { cause?: unknown };",
      "type Qualified = Space.Hidden;",
    ].join("\n"),
  );
  expect(
    result.findings
      .filter((finding) => finding.endsWith(" anti-slop(no-unknown-type-aliases)"))
      .map((finding) => Number.parseInt(finding, 10)),
  ).toEqual([1, 2, 3, 4, 7, 8]);
  expect(result.stdout).toContain(
    "This type alias hides unknown. Keep unknown explicit at the parse boundary. See lint-fixes/parse-at-the-boundary.md.",
  );
});
