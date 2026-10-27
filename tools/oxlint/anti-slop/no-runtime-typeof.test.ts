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
    ].join("\n"),
  );
  expect(result.findings.filter((finding) => finding.endsWith(code))).toEqual([
    `2 ${code}`,
    `4 ${code}`,
  ]);
});

test("keeps existence probes and type-position typeof legal", async () => {
  const result = await check(
    [
      'export const hasBun = typeof Bun !== "undefined";',
      'export const noDocument = "undefined" == typeof document;',
      "const settings = { depth: 1 };",
      "export type Settings = typeof settings;",
    ].join("\n"),
  );
  expect(result.findings.filter((finding) => finding.endsWith(code))).toEqual([]);
});
