import { expect, test } from "bun:test";
import { lintProject } from "../check.ts";

const check = lintProject();
const boundaryRules = new Set([
  "anti-slop(no-unknown-parameters)",
  "anti-slop(no-runtime-typeof)",
  "anti-slop(no-unknown-returns)",
  "anti-slop(no-object-parameters)",
]);

async function boundaryFindings(lines: string[]) {
  const result = await check(lines.join("\n"));
  return result.findings.filter((finding) =>
    boundaryRules.has(finding.slice(finding.indexOf(" ") + 1)),
  );
}

test("an explicit validator checks its own subject and the members of that subject", async () => {
  const findings = await boundaryFindings([
    'import { z } from "zod";',
    "type Named = { name: string };",
    "export function isText(value: unknown): value is string {",
    '  return typeof value === "string";',
    "}",
    "export function isNamed(value: unknown): value is Named {",
    '  return value !== null && typeof value === "object" && "name" in value && typeof value.name === "string";',
    "}",
    "export const guards = {",
    "  isCount(value: unknown): value is number {",
    '    return typeof value === "number";',
    "  },",
    "};",
    "const draftSchema = z.object({ id: z.string() });",
    "export function readDraft(text: string) {",
    "  const parsed = draftSchema.safeParse(JSON.parse(text));",
    "  return parsed.success ? parsed.data.id : null;",
    "}",
    'export const hasBun = typeof Bun !== "undefined";',
    "const settings = { depth: 1 };",
    "export type Settings = typeof settings;",
  ]);
  expect(findings).toEqual([]);
});

test("the exemption covers no sibling, nested callback, alias, unrelated value, or module check", async () => {
  const findings = await boundaryFindings([
    "const limit = 1;",
    "export function isPair(value: unknown, other: unknown): value is string {",
    '  return typeof value === "string" && other === null;',
    "}",
    "export function isTexts(value: unknown): value is string[] {",
    '  return Array.isArray(value) && value.every((entry) => typeof entry === "string");',
    "}",
    "export function isLater(value: unknown): value is string {",
    '  return [0].some(() => typeof value === "string");',
    "}",
    "export function isAlias(value: unknown): value is string {",
    "  const alias = value;",
    '  return typeof alias === "string";',
    "}",
    "export function isLimited(value: unknown): value is number {",
    '  return typeof limit === "number" && value === limit;',
    "}",
    "export const kind = typeof limit;",
  ]);
  expect(findings).toEqual([
    "2 anti-slop(no-unknown-parameters)",
    "6 anti-slop(no-runtime-typeof)",
    "9 anti-slop(no-runtime-typeof)",
    "13 anti-slop(no-runtime-typeof)",
    "16 anti-slop(no-runtime-typeof)",
    "18 anti-slop(no-runtime-typeof)",
  ]);
});

test("a generic, asserting, broad, or non-unknown predicate gets no exemption", async () => {
  const findings = await boundaryFindings([
    "type Anything = unknown;",
    "export function isAnything<T>(value: unknown): value is T {",
    '  return typeof value === "object";',
    "}",
    "export function assertText(value: unknown): asserts value is string {",
    '  if (typeof value !== "string") return;',
    "}",
    "export function isUnknown(value: unknown): value is unknown {",
    '  return typeof value === "string";',
    "}",
    "export function isObject(value: unknown): value is object {",
    '  return typeof value === "object";',
    "}",
    "export function isEmpty(value: unknown): value is {} {",
    '  return typeof value === "object";',
    "}",
    "export function isLoose(value: unknown): value is Anything {",
    '  return typeof value === "string";',
    "}",
    "export function isSmall(value: string | number): value is string {",
    '  return typeof value === "string";',
    "}",
    "export function isDefault(value: unknown = 1): value is number {",
    '  return typeof value === "number";',
    "}",
    "export type Guard = (value: unknown) => value is string;",
  ]);
  expect(findings).toEqual([
    "2 anti-slop(no-unknown-parameters)",
    "3 anti-slop(no-runtime-typeof)",
    "5 anti-slop(no-unknown-parameters)",
    "6 anti-slop(no-runtime-typeof)",
    "8 anti-slop(no-unknown-parameters)",
    "9 anti-slop(no-runtime-typeof)",
    "11 anti-slop(no-unknown-parameters)",
    "12 anti-slop(no-runtime-typeof)",
    "14 anti-slop(no-unknown-parameters)",
    "15 anti-slop(no-runtime-typeof)",
    "17 anti-slop(no-unknown-parameters)",
    "18 anti-slop(no-runtime-typeof)",
    "21 anti-slop(no-runtime-typeof)",
    "23 anti-slop(no-unknown-parameters)",
    "24 anti-slop(no-runtime-typeof)",
    "26 anti-slop(no-unknown-parameters)",
  ]);
});

test("a validator file still rejects unrelated violations and name-based exemptions", async () => {
  const findings = await boundaryFindings([
    "type Draft = { id: string };",
    "export function isText(value: unknown): value is string {",
    '  return typeof value === "string";',
    "}",
    "export function describe(cause: unknown) {",
    "  return String(cause);",
    "}",
    "export function parse(value: unknown): Draft {",
    "  return { id: String(value) };",
    "}",
    "export function read(text: string): unknown {",
    "  return JSON.parse(text);",
    "}",
    "export function keys(value: object) {",
    "  return Object.keys(value);",
    "}",
  ]);
  expect(findings).toEqual([
    "5 anti-slop(no-unknown-parameters)",
    "8 anti-slop(no-unknown-parameters)",
    "11 anti-slop(no-unknown-returns)",
    "14 anti-slop(no-object-parameters)",
  ]);
});

test("an enclosing type parameter, a broad dictionary, or a broad intersection gets no exemption", async () => {
  const findings = await boundaryFindings([
    "export function outer<T>() {",
    "  return function isT(value: unknown): value is T {",
    '    return typeof value === "string";',
    "  };",
    "}",
    "export class Box<T> {",
    "  isList(value: unknown): value is T[] {",
    '    return typeof value === "object";',
    "  }",
    "}",
    "export function isRecord(value: unknown): value is Record<string, unknown> {",
    '  return typeof value === "object";',
    "}",
    "export function isBoth(value: unknown): value is object & {} {",
    '  return typeof value === "object";',
    "}",
    "export function isTexts(value: unknown): value is Record<string, string> {",
    '  return typeof value === "object";',
    "}",
  ]);
  expect(findings).toEqual([
    "2 anti-slop(no-unknown-parameters)",
    "3 anti-slop(no-runtime-typeof)",
    "7 anti-slop(no-unknown-parameters)",
    "8 anti-slop(no-runtime-typeof)",
    "11 anti-slop(no-unknown-parameters)",
    "12 anti-slop(no-runtime-typeof)",
    "14 anti-slop(no-unknown-parameters)",
    "15 anti-slop(no-runtime-typeof)",
  ]);
});
