import { expect, test } from "bun:test";
import { lintProject } from "../check.ts";

const check = lintProject();
const code = "anti-slop(no-runtime-typeof)";

test("rejects a runtime typeof outside a validator subject", async () => {
  const result = await check(
    [
      "export function label(value: string | number) {",
      '  return typeof value === "string" ? value : String(value);',
      "}",
      "export const kind = typeof label;",
      'export const joined = typeof label + "undefined";',
      'export const compared = typeof label < "undefined";',
      "export const named = typeof label === kind;",
    ].join("\n"),
  );
  expect(result.findings.filter((finding) => finding.endsWith(code))).toEqual([
    `2 ${code}`,
    `4 ${code}`,
    `5 ${code}`,
    `6 ${code}`,
    `7 ${code}`,
  ]);
});

test("keeps existence probes and type-position typeof legal", async () => {
  const result = await check(
    [
      'export const hasBun = typeof Bun !== "undefined";',
      'export const noDocument = "undefined" == typeof document;',
      'export const noWindow = typeof window === "undefined";',
      'export const hasProcess = typeof process != "undefined";',
      "export const negated = !hasBun;",
      "export function isText(value: unknown): value is string {",
      '  return typeof value === "string";',
      "}",
      "const settings = { depth: 1 };",
      "export type Settings = typeof settings;",
    ].join("\n"),
  );
  expect(result.findings.filter((finding) => finding.endsWith(code))).toEqual([]);
});

test("names the fix topic", async () => {
  const result = await check("export function kind(value: string) { return typeof value; }");
  expect(result.stdout).toContain(
    "A `typeof` check narrows a representation without its contract. Parse input at its I/O boundary, then branch on the domain value. See lint-fixes/parse-at-the-boundary.md.",
  );
});
