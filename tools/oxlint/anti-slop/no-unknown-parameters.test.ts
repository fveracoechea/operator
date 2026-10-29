import { expect, test } from "bun:test";
import { lintProject } from "../check.ts";

const check = lintProject();
const code = "anti-slop(no-unknown-parameters)";

test("rejects unknown parameters on functions and signatures", async () => {
  const result = await check(
    [
      "export function read(input: unknown) { return input; }",
      "export function either(input: string | unknown) { return input; }",
      "export function qualify(cause: unknown) { return String(cause); }",
      "export type Handler = { handle(input: unknown): void };",
      "export const handlers = [(input: unknown) => input];",
    ].join("\n"),
  );
  expect(result.findings.filter((finding) => finding.endsWith(code))).toEqual(
    [1, 2, 3, 4, 5].map((line) => `${line} ${code}`),
  );
});

test("accepts named domain inputs and the subject of an explicit validator", async () => {
  const result = await check(
    [
      "type Draft = { id: string };",
      "export function id(draft: Draft) { return draft.id; }",
      "export function list(values: unknown[]) { return values.length; }",
      "export const loose = function (input) { return input; };",
      "export function isDraft(value: unknown): value is Draft {",
      '  return value !== null && typeof value === "object" && "id" in value && typeof value.id === "string";',
      "}",
    ].join("\n"),
  );
  expect(result.findings.filter((finding) => finding.endsWith(code))).toEqual([]);
});

test("names the parameter and the fix topic", async () => {
  const result = await check("export function read(input: unknown) { return input; }");
  expect(result.stdout).toContain(
    "Parameter `input` leaves input unparsed. Accept a named domain type, and run the schema at the I/O boundary before the call. See lint-fixes/parse-at-the-boundary.md.",
  );
});
