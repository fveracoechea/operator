import { expect, test } from "bun:test";
import { lintProject } from "../tools/oxlint/check.ts";

const check = lintProject();

test("classic complexity accepts 14 and rejects 15 through the real lint command", async () => {
  function source(branches: number) {
    const decisions = Array.from(
      { length: branches },
      (_, index) => `if (input === ${index}) return ${index};`,
    ).join("\n");
    return `export function evaluate(input: number) { ${decisions} return -1; }`;
  }
  const valid = await check(source(13));
  expect(valid.codes).toEqual([]);
  expect(valid.exitCode).toBe(0);
  const invalid = await check(source(14));
  expect(invalid.exitCode).toBe(1);
  expect(invalid.codes).toContain("eslint(complexity)");
});

test("classic complexity counts switch cases rather than one switch", async () => {
  function source(cases: number) {
    const decisions = Array.from(
      { length: cases },
      (_, index) => `case ${index}: { return ${index}; }`,
    ).join("\n");
    return `export function evaluate(input: number) { switch (input) { ${decisions} default: { return -1; } } }`;
  }
  const valid = await check(source(13));
  expect(valid.exitCode).toBe(0);
  expect(valid.codes).toEqual([]);
  const invalid = await check(source(14));
  expect(invalid.exitCode).toBe(1);
  expect(invalid.codes).toContain("eslint(complexity)");
});

test("preserves the accumulating-spread guard through the real lint command", async () => {
  const invalid = await check(
    "export const values = [1].reduce<number[]>((items, item) => [...items, item], []);",
  );
  expect(invalid.exitCode).toBe(1);
  expect(invalid.codes).toContain("oxc(no-accumulating-spread)");
  const valid = await check(
    "export const values = [1].reduce<number[]>((items, item) => { items.push(item); return items; }, []);",
  );
  expect(valid.exitCode).toBe(0);
  expect(valid.codes).toEqual([]);
});

test("boundary parsing and ordinary array pipelines remain valid", async () => {
  const result = await check(`
export function isText(value: unknown): value is string { return typeof value === "string"; }
export const names = [1, 2].filter((value) => value > 1).map(String);
export const item = { name: "a" } as const;
`);
  expect(result.exitCode).toBe(0);
  expect(result.codes).toEqual([]);
});

test.each([
  {
    rule: "no-misused-promises",
    invalid:
      "declare function subscribe(callback: () => void): void; subscribe(async () => { await Promise.resolve(); });",
    valid:
      "declare function subscribe(callback: () => Promise<void>): Promise<void>; await subscribe(async () => { await Promise.resolve(); });",
  },
  {
    rule: "no-unsafe-assignment",
    invalid: 'export const value = JSON.parse("1");',
    valid: 'import { z } from "zod"; export const value = z.number().parse(JSON.parse("1"));',
  },
  {
    rule: "no-unsafe-argument",
    invalid: 'declare function consume(value: number): void; consume(JSON.parse("1"));',
    valid:
      'import { z } from "zod"; declare function consume(value: number): void; consume(z.number().parse(JSON.parse("1")));',
  },
  {
    rule: "no-unsafe-call",
    invalid: 'JSON.parse("1")();',
    valid: "declare function consume(): void; consume();",
  },
  {
    rule: "no-unsafe-member-access",
    invalid: 'export const value: unknown = JSON.parse("{}").name;',
    valid:
      'import { z } from "zod"; export const value = z.object({ name: z.string() }).parse(JSON.parse(\'{"name":"test"}\')).name;',
  },
  {
    rule: "no-unsafe-return",
    invalid: 'export function read(): number { return JSON.parse("1"); }',
    valid:
      'import { z } from "zod"; export function read(): number { return z.number().parse(JSON.parse("1")); }',
  },
  {
    rule: "return-await",
    invalid:
      'export async function read() { try { return Promise.reject(new Error("failure")); } catch { return 0; } }',
    valid:
      'export async function read() { try { return await Promise.reject(new Error("failure")); } catch { return 0; } }',
  },
])(
  "enforces $rule in production and tests without a broad test exception",
  async ({ rule, invalid, valid }) => {
    for (const path of ["lib/lint-probe.ts", "lib/lint-probe.test.ts"]) {
      const bad = await check(invalid, { path });
      expect(bad.exitCode).toBe(1);
      expect(bad.codes).toContain(`typescript(${rule})`);
      const good = await check(valid, { path });
      expect(good.codes).toEqual([]);
      expect(good.exitCode).toBe(0);
    }
  },
);

test("switch union members cannot disappear into default", async () => {
  const invalid = await check(
    'export function decide(input: "ready" | "waiting") { switch (input) { case "ready": { return 1; } default: { return 0; } } }',
  );
  expect(invalid.codes).toContain("typescript(switch-exhaustiveness-check)");
  const valid = await check(
    'export function decide(input: "ready" | "waiting") { switch (input) { case "ready": { return 1; } case "waiting": { return 0; } } }',
  );
  expect(valid.codes).toEqual([]);
});

test("unsafe assertions have only their approved test exception", async () => {
  const source = "declare const input: unknown; export const text = input as string;";
  const production = await check(source);
  expect(production.codes).toContain("typescript(no-unsafe-type-assertion)");
  const tests = await check(source, { path: "lib/lint-probe.test.ts" });
  expect(tests.codes).toEqual([]);
});

test.each([
  {
    rule: "await-thenable",
    source:
      "declare function readNumber(): number; export async function read() { await readNumber(); return 1; }",
  },
  {
    rule: "unbound-method",
    source:
      "class Counter { count = 0; increment() { this.count += 1; } } export const update = new Counter().increment;",
  },
])("keeps the approved test exception for $rule narrow", async ({ rule, source }) => {
  const production = await check(source);
  expect(production.codes).toContain(`typescript(${rule})`);
  const tests = await check(source, { path: "lib/lint-probe.test.ts" });
  expect(tests.codes).toEqual([]);
  expect(tests.exitCode).toBe(0);
});
