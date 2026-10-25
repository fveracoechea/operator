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
    'export type Item = { id: string; cause?: unknown }; export function read(input: unknown) { return typeof input === "string" ? input : null; }',
  );
  expect(valid.codes).toEqual([]);
});

test("rejects each alias in a chain rather than only its unknown declaration", async () => {
  const invalid = await check("type Hidden = unknown; export type Again = Hidden;");
  expect(
    invalid.codes.filter((code) => code === "anti-slop(no-unknown-type-aliases)"),
  ).toHaveLength(2);
});
