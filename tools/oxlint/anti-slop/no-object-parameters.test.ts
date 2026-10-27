import { expect, test } from "bun:test";
import { lintProject } from "../check.ts";

const check = lintProject();
const code = "anti-slop(no-object-parameters)";

test("rejects the broad object type on parameters, through unions and local aliases", async () => {
  const result = await check(
    [
      "type Anything = object;",
      "export function keys(value: object) { return Object.keys(value); }",
      "export function maybe(value: object | null) { return value; }",
      "export function aliased(value: Anything) { return value; }",
      "export function rest(...values: object[]) { return values; }",
      "export type Visit = (value: object) => void;",
    ].join("\n"),
  );
  expect(result.findings.filter((finding) => finding.endsWith(code))).toEqual(
    [2, 3, 4, 6].map((line) => `${line} ${code}`),
  );
});

test("accepts named owner types and records", async () => {
  const result = await check(
    [
      "type Draft = { id: string };",
      "type Anything = object;",
      "export function id(draft: Draft) { return draft.id; }",
      "export function same<Anything>(value: Anything) { return value; }",
      "export function count(values: Record<string, number>) { return Object.keys(values).length; }",
    ].join("\n"),
  );
  expect(result.findings.filter((finding) => finding.endsWith(code))).toEqual([]);
});
